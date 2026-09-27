import type { Doc } from "../convex/_generated/dataModel";
import type { EngineItem, ItemStatus, ItemType, TokenUsage } from "./engine";

/**
 * A turn's trace, as the runner reports it: one span per item the engine
 * works through, and the tokens its model responses used. Spans are buffered
 * here and sent with the reply's streaming flush, so a report carries only
 * what changed since the last one.
 */

export type Span = Pick<Doc<"runSpans">, "callId" | "kind" | "name" | "status" | "startedAt" | "durationMs" | "input" | "output">;
export type TraceReport = {
  spans: Span[];
  usage?: NonNullable<Doc<"runs">["usage"]>;
  steps?: number;
  /** How full the thread's context is: the latest response's input, and the model's window. */
  context?: { used: number; window: number };
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

/**
 * The span kind for each canonical item the trace keeps. Compaction, plans
 * and the like are not steps the owner needs to see, and are left out.
 */
const KINDS: Partial<Record<ItemType, Span["kind"]>> = {
  command_execution: "command",
  file_change: "fileChange",
  mcp_tool_call: "mcpToolCall",
  dynamic_tool_call: "dynamicToolCall",
  web_search: "webSearch",
  image_generation: "imageGeneration",
  reasoning: "reasoning",
};
const STATUS: Record<ItemStatus, Span["status"]> = { running: "running", completed: "ok", failed: "error", declined: "declined" };

/** What a span records for an item: its name, and its input and output cut to size. A command's output keeps its end. */
function describe(item: EngineItem): Omit<Span, "callId" | "startedAt" | "durationMs"> | null {
  const kind = KINDS[item.type];
  if (!kind) return null;
  return {
    kind,
    name: item.title,
    status: STATUS[item.status],
    input: item.input === undefined ? undefined : truncate(item.input),
    output: item.output === undefined ? undefined : item.type === "command_execution" ? truncateTail(item.output) : truncate(item.output),
  };
}

export class TurnTrace {
  private spans = new Map<string, Span>();
  private dirty = new Set<string>();
  // Adapted from vercel/eve (Apache-2.0): packages/eve/src/cli/dev/tui/turn-clock.ts
  private usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  private steps = 0;
  private usageDirty = false;
  private context: { used: number; window: number } | undefined;

  /** Records an item's start, change or end. False when the trace does not keep that kind of item. */
  item(phase: "started" | "updated" | "completed", item: EngineItem, atMs: number): boolean {
    const described = describe(item);
    if (!described) return false;
    const known = this.spans.get(item.id);
    const reported = item.durationMs;
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
  addUsage(last: TokenUsage, contextWindow?: number) {
    // The latest response read the whole thread so far: its input is how full the context is.
    if (contextWindow) this.context = { used: last.inputTokens ?? 0, window: contextWindow };
    this.usage.inputTokens += last.inputTokens ?? 0;
    this.usage.cachedInputTokens += last.cachedInputTokens ?? 0;
    this.usage.outputTokens += last.outputTokens ?? 0;
    this.usage.reasoningTokens += last.reasoningTokens ?? 0;
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
      ...(this.usageDirty ? { usage: { ...this.usage }, steps: this.steps, ...(this.context ? { context: this.context } : {}) } : {}),
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
