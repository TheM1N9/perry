import type { ChatId, Perry, Turn } from "../scripts/perry-client";
import type { Assertion, Outcome, Severity } from "./expect";
import { judgeWithCodex } from "./judge";

/**
 * Behaviour checks against the live Perry, modelled on eve's evals. An eval
 * drives Perry through web chats with `t.send`, and asserts on what came back.
 * Every assertion is recorded rather than thrown, so one run reports every
 * miss, and each carries a severity: a gate fails the eval, a soft one below
 * its bar only marks it "scored", which `--strict` treats as a failure.
 */

export type AssertionHandle = {
  gate(threshold?: number): AssertionHandle;
  soft(threshold?: number): AssertionHandle;
  atLeast(threshold: number): AssertionHandle;
  label(name: string): AssertionHandle;
};

export type AssertionResult = {
  name: string;
  score: number;
  severity: Severity;
  threshold?: number;
  passed: boolean;
  errored: boolean;
  message?: string;
  metadata?: Record<string, unknown>;
};

export type Verdict = "passed" | "failed" | "scored";

export type EvalContext = {
  /** Send a message, in a fresh web chat unless `chat` names one this eval opened, and wait for the reply. */
  send(text: string, options?: { chat?: ChatId; model?: string }): Promise<Turn>;
  /** Grade a value, such as a turn's message. */
  check(value: unknown, assertion: Assertion): AssertionHandle;
  /** One of Perry's tools ran, in this turn or anywhere in the eval. A gate. */
  calledTool(name: string, turn?: Turn): AssertionHandle;
  /** One of Perry's tools did not run, in this turn or anywhere in the eval. A gate. */
  notCalledTool(name: string, turn?: Turn): AssertionHandle;
  /** Codex grades the last reply, or `on`, against the criteria. Soft; a judge that errors fails the gate. */
  judge(criteria: string, options?: { on?: string }): AssertionHandle;
  /** Undo something the eval did outside its chats, such as a memory. Runs after the chats are deleted. */
  cleanup(undo: () => unknown): void;
  log(message: string): void;
  perry: Perry;
};

export type EvalInput = {
  description?: string;
  tags?: string[];
  timeoutMs?: number;
  test(t: EvalContext): Promise<void>;
};

export type EvalDefinition = EvalInput & { _tag: "PerryEval" };

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/evals/define-eval.ts
/** One eval per `evals/<name>.eval.ts` file, as its default export. The file path is its id. */
export function defineEval(input: EvalInput): EvalDefinition {
  if (typeof input.test !== "function") throw new Error("An eval needs a test(t) function.");
  if (input.timeoutMs !== undefined && !(input.timeoutMs > 0)) throw new Error("timeoutMs must be positive.");
  return { ...input, _tag: "PerryEval" };
}

export function isEval(value: unknown): value is EvalDefinition {
  return typeof value === "object" && value !== null && (value as { _tag?: unknown })._tag === "PerryEval";
}

export type EvalResult = {
  id: string;
  description?: string;
  tags: string[];
  verdict: Verdict;
  assertions: AssertionResult[];
  turns: Turn[];
  logs: string[];
  error?: string;
  cleanupErrors: string[];
  startedAt: string;
  durationMs: number;
};

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** Run one eval: its test, then its assertions, then deleting what it made, whatever happened. */
export async function runEval(id: string, definition: EvalDefinition, perry: Perry, options: { judgeModel?: string } = {}): Promise<EvalResult> {
  const startedAt = new Date();
  const collector = new AssertionCollector();
  const turns: Turn[] = [];
  const chats = new Set<ChatId>();
  const undo: Array<() => unknown> = [];
  const logs: string[] = [];
  const timeoutMs = definition.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const abort = new AbortController();

  const t: EvalContext = {
    async send(text, { chat, model } = {}) {
      abort.signal.throwIfAborted();
      if (chat && !chats.has(chat)) throw new Error("t.send can only continue a chat this eval opened.");
      const chatId = chat ?? await perry.createChat();
      chats.add(chatId);
      const turn = await perry.send(chatId, text, { model, signal: abort.signal });
      turns.push(turn);
      if (turn.error) throw new Error(`Perry's turn failed: ${turn.error}`);
      return turn;
    },
    check(value, assertion) {
      return collector.record(assertion.name, assertion.severity, async () => assertion.evaluate(value));
    },
    calledTool(name, turn) {
      return collector.deferred(`calledTool(${name})`, () => {
        const calls = (turn ? [turn] : turns).flatMap((item) => item.toolCalls);
        return calls.includes(name)
          ? { score: 1, metadata: { calls: calls.filter((call) => call === name).length } }
          : { score: 0, message: `expected a call to "${name}"; observed tools: [${calls.join(", ")}]` };
      });
    },
    notCalledTool(name, turn) {
      return collector.deferred(`notCalledTool(${name})`, () => {
        const count = (turn ? [turn] : turns).flatMap((item) => item.toolCalls).filter((call) => call === name).length;
        return count === 0 ? { score: 1 } : { score: 0, message: `"${name}" was called ${count} time(s)` };
      });
    },
    // Adapted from vercel/eve (Apache-2.0): packages/eve/src/evals/judge.ts
    judge(criteria, { on } = {}) {
      const last = turns.at(-1);
      const prompt = last?.prompt ?? "";
      const output = on ?? last?.message ?? "";
      return collector.record("judge", "soft", async () => {
        const judgment = await judgeWithCodex({ criteria, prompt, output, model: options.judgeModel });
        return { score: judgment.probability, message: judgment.reason, metadata: { criteria, judgment } };
      });
    },
    cleanup(fn) {
      undo.push(fn);
    },
    log(message) {
      logs.push(message);
    },
    perry,
  };

  let error: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      definition.test(t),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const reason = new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s.`);
          abort.abort(reason);
          reject(reason);
        }, timeoutMs);
      }),
    ]);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    clearTimeout(timer);
    // A test still running past its timeout stops at its next send.
    abort.abort(new Error("The eval has finished."));
  }
  const assertions = await collector.finalize();

  const cleanupErrors: string[] = [];
  for (const chat of chats) {
    await perry.discard(chat).catch((cause) => cleanupErrors.push(`chat ${chat}: ${cause instanceof Error ? cause.message : String(cause)}`));
  }
  for (const fn of undo.reverse()) {
    try { await fn(); } catch (cause) { cleanupErrors.push(cause instanceof Error ? cause.message : String(cause)); }
  }

  return {
    id,
    description: definition.description,
    tags: definition.tags ?? [],
    verdict: computeVerdict(error, assertions),
    assertions,
    turns,
    logs,
    error,
    cleanupErrors,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
  };
}

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/evals/runner/verdict.ts
/**
 * An error or a failed gate fails the eval; a soft assertion below its bar at
 * worst demotes it to "scored". Soft assertions without a bar are tracked only.
 */
export function computeVerdict(error: string | undefined, assertions: AssertionResult[]): Verdict {
  if (error !== undefined) return "failed";
  let demoted = false;
  for (const assertion of assertions) {
    if (assertion.passed) continue;
    if (assertion.severity === "gate") return "failed";
    demoted = true;
  }
  return demoted ? "scored" : "passed";
}

type Entry = {
  name: string;
  severity: Severity;
  threshold?: number;
  score: number;
  message?: string;
  metadata?: Record<string, unknown>;
  errored: boolean;
  /** Evaluated once the test has finished, against every turn it made. */
  later?: () => Outcome;
};

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/evals/assertions/collector.ts
/**
 * The assertions an eval records. Value and judge assertions start at once,
 * because their value is captured now; tool assertions wait for the end of
 * the test. `finalize` settles both into the ordered results the verdict reads.
 */
class AssertionCollector {
  private entries: Entry[] = [];
  private pending: Promise<void>[] = [];

  record(name: string, severity: Severity, score: () => Promise<Outcome>): AssertionHandle {
    const entry: Entry = { name, severity, score: 0, errored: false };
    this.entries.push(entry);
    this.pending.push(score().then(
      (outcome) => { Object.assign(entry, outcome); },
      (cause) => {
        // An assertion that throws, such as a judge that could not answer, is a
        // failed gate whatever severity it was given.
        Object.assign(entry, { score: 0, severity: "gate", threshold: undefined, errored: true, message: cause instanceof Error ? cause.message : String(cause) });
      },
    ));
    return handle(entry);
  }

  deferred(name: string, evaluate: () => Outcome): AssertionHandle {
    const entry: Entry = { name, severity: "gate", score: 0, errored: false, later: evaluate };
    this.entries.push(entry);
    return handle(entry);
  }

  async finalize(): Promise<AssertionResult[]> {
    await Promise.all(this.pending);
    return this.entries.map((entry) => {
      if (entry.later) Object.assign(entry, entry.later());
      return {
        name: entry.name,
        score: entry.score,
        severity: entry.severity,
        threshold: entry.threshold,
        passed: passed(entry),
        errored: entry.errored,
        message: entry.message,
        metadata: entry.metadata,
      };
    });
  }
}

/** A gate's bar defaults to 1; a soft assertion with no bar always passes. */
function passed(entry: Entry): boolean {
  if (entry.errored) return false;
  const min = entry.threshold ?? (entry.severity === "gate" ? 1 : undefined);
  return min === undefined || entry.score >= min;
}

function handle(entry: Entry): AssertionHandle {
  const self: AssertionHandle = {
    gate(threshold) {
      if (!entry.errored) Object.assign(entry, { severity: "gate", threshold });
      return self;
    },
    soft(threshold) {
      if (!entry.errored) Object.assign(entry, { severity: "soft", threshold });
      return self;
    },
    atLeast(threshold) {
      return self.soft(threshold);
    },
    label(name) {
      if (!name.trim()) throw new Error("Assertion labels must be non-empty.");
      entry.name = `${entry.name} [${name.trim()}]`;
      return self;
    },
  };
  return self;
}
