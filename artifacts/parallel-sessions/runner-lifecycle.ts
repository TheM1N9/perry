/// <reference lib="es2024.promise" />

import ts from "typescript";
import { getFunctionName } from "convex/server";
import { api } from "../../convex/_generated/api";
import { runLabel } from "../../convex/lib/commands";
import { ENGINE_LABELS, refusal } from "../../convex/lib/engines";
import { LIMIT_HIT } from "../../convex/lib/usage";
import { turnErrorCode } from "../../lib/turn-errors";
import { createReplyStream, streamFlushMs } from "../../runner/stream-reply";
import { TurnTrace } from "../../runner/trace";

/** Replay the real runner lifecycle with backend claims and a gated fake engine. */
export async function replayRunnerLifecycle({ source, call, db, token, key, running, check }: {
  source: string; call: (path: string, args?: any) => Promise<any>; db: any;
  token: string; key: string; running: (name: string) => Promise<any>;
  check: (name: string, pass: boolean) => void;
}) {
  const start = source.indexOf("  const runJob = async");
  const end = source.indexOf("  /** How many turns run at once", start);
  const stopStart = source.indexOf("  const endTurn = (jobId: string)");
  const stopEnd = source.indexOf("  const interruptIfAsked", stopStart);
  if ([start, end, stopStart, stopEnd].some(index => index < 0)) throw new Error("Runner lifecycle boundary changed");
  const compile = (part: string) => ts.transpileModule(part, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  for (const mode of ["success", "failure", "saved"] as const) {
    const target = await running(`stop-target-${mode}`);
    const sibling = await running(`delivery-${mode}`);
    const native = Promise.withResolvers<any>();
    const started = Promise.withResolvers<void>();
    const mediaEntered = Promise.withResolvers<void>();
    const media = Promise.withResolvers<any[]>();
    const finishEntered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let killed = 0, abandoned = 0, nativeCalls = 0;
    const engine = {
      kind: "codex", label: "Fixture", capabilities: {},
      kill() { killed++; },
      runTurn(_input: unknown, sink: any) {
        nativeCalls++;
        sink.onStarted({ cursor: `native-delivery-${mode}`, turnId: `delivery-${mode}` });
        started.resolve();
        return native.promise;
      },
    };
    const turn: any = { jobId: sibling.turn, conversationId: sibling.chat, engine, asking: 0 };
    const active = new Map([
      [target.turn, { jobId: target.turn, engine, handle: {}, abandon() { abandoned++; } }],
      [sibling.turn, turn],
    ]);
    const endTurn = new Function("active", `${compile(source.slice(stopStart, stopEnd))}; return endTurn;`)(active);
    const dependencies = {
      savedResult: () => mode === "saved" ? { response: "Saved fixture result" } : undefined,
      saveResult: () => {}, createReplyStream, streamFlushMs, TurnTrace, runLabel, ENGINE_LABELS, refusal, LIMIT_HIT, turnErrorCode,
      api, token, engines: new Map([["codex", engine]]), stopRequested: new Set(), stopping: new Set(), endedOnStop: new Set(),
      client: { mutation: async (ref: any, args: any) => {
        const path = getFunctionName(ref);
        if (path === "codex:finishTurn") { finishEntered.resolve(); await finish.promise; }
        return await call(path, args);
      } },
      yellow: (text: string) => text, dim: (text: string) => text,
      tooOld: () => undefined, message: (error: unknown) => error instanceof Error ? error.message : String(error),
      watchdog: () => ({ active() {}, done() {}, expired: () => false }),
      TURN_IDLE_MS: 60_000, TURN_TIMEOUT_MS: 60_000,
      patience: {}, interruptIfAsked() {}, steerIfAsked() {}, applyAccess() {},
      localise: async () => [], guestFiles: (files: any) => files,
      withSkills: (_engine: any, prompt: string) => ({ prompt }), workdir: ".", toolsFor: () => undefined,
      keepMedia: async () => { mediaEntered.resolve(); return await media.promise; },
      readLimitsSoon() {}, settleSteers: async () => {}, clearSteers() {},
    };
    const runJob = new Function(...Object.keys(dependencies), `${compile(source.slice(start, end))}; return runJob;`)(...Object.values(dependencies));
    const job = runJob({ ...db.get(sibling.turn), resumeCursor: `native-delivery-${mode}` }, turn);
    // Fail instead of hanging forever if a replay dependency or production boundary changes.
    const timeout = Promise.withResolvers<never>();
    const deadline = setTimeout(() => timeout.reject(new Error("Runner replay timed out")), 10_000);
    const wait = <T,>(work: Promise<T>) => Promise.race([work, timeout.promise]);
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await call("dashboard:stopChat", { key, id: target.chat });
      if (mode !== "saved") {
        await wait(started.promise);
        endTurn(target.turn);
        check(`${mode}: hard Stop preserves a sibling doing native work`, killed === 0 && abandoned === 1);
        stopTimer = turn.stopTimer = setTimeout(() => {}, 60_000);
        if (mode === "failure") native.reject(new Error("Fixture engine failure"));
        else {
          native.resolve({ state: "completed", cursor: `native-delivery-${mode}`, text: "Independent sibling result", images: [] });
          await wait(mediaEntered.promise);
          check("settled engine releases ownership and Stop timer before media delivery", !turn.engine && !turn.handle && !turn.stopTimer && active.has(sibling.turn));
          endTurn(target.turn);
          check("media delivery does not prevent hard Stop", Number(killed) === 1);
          media.resolve([]);
        }
      }
      await wait(finishEntered.promise);
      check(`${mode}: result acknowledgement holds the chat without holding its engine`, !turn.engine && !turn.handle && !turn.stopTimer && active.has(sibling.turn) && db.get(sibling.turn)?.status === "running");
      const before = killed;
      endTurn(target.turn);
      check(`${mode}: pending acknowledgement does not prevent hard Stop`, killed === before + 1);
      if (mode === "saved") check("saved result replay never starts native work", nativeCalls === 0);
      finish.resolve();
      await job;
      await call("codex:finalizeTurn", { id: sibling.turn });
      await call("codex:finishTurn", { token, id: target.turn, response: "Late target result" });
      await call("codex:finalizeTurn", { id: target.turn });
      check(`${mode}: delivery preserves sibling result and target cancellation`, db.get(target.turn)?.stopped === true && (mode === "failure" ? Boolean(db.get(sibling.turn)?.error) : db.get(sibling.turn)?.response === (mode === "saved" ? "Saved fixture result" : "Independent sibling result")));
    } finally {
      clearTimeout(deadline);
      clearTimeout(stopTimer);
      native.resolve({ state: "completed", text: "", images: [] });
      media.resolve([]); finish.resolve();
      await job;
    }
  }
}
