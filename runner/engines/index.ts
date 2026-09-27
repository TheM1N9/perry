import type { Engine, EngineKind } from "../engine";
import { CodexEngine } from "./codex";
import { GrokEngine } from "./grok";

/**
 * The engines this runner can drive. Each is made once and starts its CLI
 * only when first used. An engine PR adds its line here.
 */
export function createEngines(options: { warn: (line: string) => void }): Map<EngineKind, Engine> {
  const engines: Engine[] = [
    new CodexEngine(options.warn),
    new GrokEngine(options.warn),
  ];
  return new Map(engines.map((engine) => [engine.kind, engine]));
}
