import type { Doc } from "../convex/_generated/dataModel";
import { ASSISTANT_MCP, type TokenUsage, type TurnItem } from "./codex";

/**
 * A Codex turn's trace, as the runner reports it: one span per item Codex
 * works through, and the tokens its model responses used. Spans are buffered
 * here and sent with the reply's streaming flush, so a report carries only
 * what changed since the last one.
 */

export type Span = Pick<Doc<"runSpans">, "callId" | "kind" | "name" | "status" | "startedAt" | "durationMs" | "input" | "output">;
export type TraceReport = {
  spans: Span[];
  usage?: NonNullable<Doc<"runs">["usage"]>;
  steps?: number;
};

/** Span input and output are cut to this many bytes; convex/codex.ts keeps the same cap. */
const SPAN_BYTES = 2_048;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MARKER = "... [truncated]";
const TAIL_MARKER = "[truncated] ...";

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/tracing/telemetry-budget.ts
/** Keeps the start of `text` within `maxBytes`, marking the cut, without splitting a character. */
export function truncate(text: string, maxBytes = SPAN_BYTES): string {
  const prefix = text.slice(0, maxBytes + 1);
  const bytes = encoder.encode(prefix);
  if (prefix.length === text.length && bytes.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes - MARKER.length);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return decoder.decode(bytes.subarray(0, end)) + MARKER;
}

/** Keeps the end instead: a command's last lines say how it went. */
export function truncateTail(text: string, maxBytes = SPAN_BYTES): string {
  const suffix = text.slice(-(maxBytes + 1));
  const bytes = encoder.encode(suffix);
  if (suffix.length === text.length && bytes.length <= maxBytes) return text;
  let start = bytes.length - Math.max(0, maxBytes - TAIL_MARKER.length);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return TAIL_MARKER + decoder.decode(bytes.subarray(start));
}

const json = (value: unknown) => {
  try { return value === undefined || value === null ? undefined : truncate(JSON.stringify(value)); }
  catch { return undefined; }
};

/** Codex's item statuses: CommandExecutionStatus, PatchApplyStatus, McpToolCallStatus. */
const STATUS: Record<string, Span["status"]> = { inProgress: "running", completed: "ok", failed: "error", declined: "declined" };

/**
 * What a span records for each ThreadItem variant the trace keeps. Messages,
 * plans and the like are the reply itself and are left out.
 */
function describe(item: TurnItem, phase: "started" | "completed"): Omit<Span, "callId" | "startedAt" | "durationMs"> | null {
  const done: Span["status"] = phase === "started" ? "running" : "ok";
  const status = (value: unknown) => STATUS[String(value)] ?? done;
  switch (item.type) {
    case "commandExecution":
      return {
        kind: "command",
        name: item.command,
        status: item.status === "completed" && typeof item.exitCode === "number" && item.exitCode !== 0 ? "error" : status(item.status),
        input: truncate(`$ ${item.command}\ncwd: ${item.cwd}`),
        output: phase === "started" ? undefined
          : truncateTail(`${item.exitCode === null || item.exitCode === undefined ? "" : `exit ${item.exitCode}\n`}${item.aggregatedOutput ?? ""}`),
      };
    case "fileChange": {
      const changes: Array<{ path: string; kind: { type: string; move_path?: string | null }; diff: string }> = item.changes ?? [];
      return {
        kind: "fileChange",
        name: changes.map((change) => change.path).join(", ") || "file change",
        status: status(item.status),
        input: truncate(changes.map((change) => `${change.kind.move_path ? `move to ${change.kind.move_path}` : change.kind.type} ${change.path}`).join("\n")),
        output: changes.some((change) => change.diff) ? truncate(changes.map((change) => change.diff).join("\n")) : undefined,
      };
    }
    case "mcpToolCall":
      return {
        kind: "mcpToolCall",
        name: item.server === ASSISTANT_MCP ? item.tool : `${item.server}.${item.tool}`,
        status: status(item.status),
        input: json(item.arguments),
        output: item.error?.message ? truncate(item.error.message) : json(item.result?.content),
      };
    case "dynamicToolCall":
      return {
        kind: "dynamicToolCall",
        name: item.namespace ? `${item.namespace}.${item.tool}` : item.tool,
        status: item.success === false ? "error" : status(item.status),
        input: json(item.arguments),
        output: json(item.contentItems),
      };
    case "webSearch":
      return {
        kind: "webSearch",
        name: item.query || item.action?.url || "web search",
        status: done,
        input: item.query ? truncate(item.query) : undefined,
        output: json(item.action),
      };
    case "imageGeneration":
      // `result` is the image itself, in base64; the path is enough.
      return {
        kind: "imageGeneration",
        name: "image generation",
        status: item.failure ? "error" : done,
        input: item.revisedPrompt ? truncate(item.revisedPrompt) : undefined,
        output: item.failure ? json(item.failure) : item.savedPath ? truncate(item.savedPath) : undefined,
      };
    case "reasoning":
      return {
        kind: "reasoning",
        name: "reasoning",
        status: done,
        output: item.summary?.length ? truncate(item.summary.join("\n\n")) : undefined,
      };
    default:
      return null;
  }
}

export class TurnTrace {
  private spans = new Map<string, Span>();
  private dirty = new Set<string>();
  // Adapted from vercel/eve (Apache-2.0): packages/eve/src/cli/dev/tui/turn-clock.ts
  private usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  private steps = 0;
  private usageDirty = false;

  /** Records an item's start or end. False when the trace does not keep that kind of item. */
  item(phase: "started" | "completed", item: TurnItem, atMs: number): boolean {
    const described = describe(item, phase);
    if (!described) return false;
    const known = this.spans.get(item.id);
    const reported = typeof item.durationMs === "number" ? item.durationMs : undefined;
    // An item seen only at its end starts where its own duration says it did.
    const startedAt = known?.startedAt ?? (phase === "completed" ? atMs - (reported ?? 0) : atMs);
    this.spans.set(item.id, {
      ...described,
      callId: item.id,
      startedAt,
      durationMs: phase === "completed" ? Math.max(0, atMs - startedAt) : undefined,
    });
    this.dirty.add(item.id);
    return true;
  }

  /** One model response's tokens: every response is a step. */
  addUsage(last: TokenUsage) {
    this.usage.inputTokens += last.inputTokens ?? 0;
    this.usage.cachedInputTokens += last.cachedInputTokens ?? 0;
    this.usage.outputTokens += last.outputTokens ?? 0;
    this.usage.reasoningTokens += last.reasoningOutputTokens ?? 0;
    this.usage.totalTokens += last.totalTokens ?? 0;
    this.steps += 1;
    this.usageDirty = true;
  }

  // Adapted from vercel/eve (Apache-2.0): packages/eve/src/tracing/agent-tool-instrumentation.ts
  /** The turn is over: whatever is still running never finished. */
  drain(atMs: number) {
    for (const span of this.spans.values()) {
      if (span.status !== "running") continue;
      this.spans.set(span.callId, {
        ...span,
        status: "error",
        durationMs: Math.max(0, atMs - span.startedAt),
        output: span.output ?? "The turn ended before this finished.",
      });
      this.dirty.add(span.callId);
    }
  }

  /** What changed since the last report, or null when nothing did. */
  take(): TraceReport | null {
    if (this.dirty.size === 0 && !this.usageDirty) return null;
    const report: TraceReport = {
      spans: [...this.dirty].map((id) => this.spans.get(id)!),
      ...(this.usageDirty ? { usage: { ...this.usage }, steps: this.steps } : {}),
    };
    this.dirty.clear();
    this.usageDirty = false;
    return report;
  }

  /** A report that did not arrive goes out again with the next one, at its latest state. */
  retry(report: TraceReport) {
    for (const span of report.spans) this.dirty.add(span.callId);
    if (report.usage) this.usageDirty = true;
  }
}
