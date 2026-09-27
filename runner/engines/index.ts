import type { Engine, EngineKind } from "../engine";
import { ClaudeEngine } from "./claude";
import { CodexEngine } from "./codex";

/**
 * The engines this runner can drive. Each is made once and starts its CLI
 * only when first used. An engine PR adds its line here.
 */
export function createEngines(options: { warn: (line: string) => void }): Map<EngineKind, Engine> {
  const engines: Engine[] = [
    new CodexEngine(options.warn),
    new ClaudeEngine(options.warn),
  ];
  return new Map(engines.map((engine) => [engine.kind, engine]));
}
