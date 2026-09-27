import type { Engine, EngineKind } from "../engine";
import { ClaudeEngine } from "./claude";
import { CodexEngine } from "./codex";
import { GrokEngine } from "./grok";
import { fakeEngine } from "./fake";

/**
 * The engines this runner can drive. Each is made once and starts its CLI
 * only when first used. An engine PR adds its line here.
 */
export function createEngines(options: { warn: (line: string) => void }): Map<EngineKind, Engine> {
  const engines: Engine[] = [
    new CodexEngine(options.warn),
    new GrokEngine(options.warn),
    new ClaudeEngine(options.warn),
  ];
  const found = new Map(engines.map((engine) => [engine.kind, engine]));
  // End-to-end checks only (PERRY_E2E_FAKE_ENGINE, engines/fake.ts): a scripted engine in the place of one.
  const fake = fakeEngine();
  if (fake) found.set(fake.kind, fake);
  return found;
}
