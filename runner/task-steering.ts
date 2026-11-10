import type { Engine, TurnHandle } from "./engine";

/** The runner's existing steering gate: never cancel and resend to deliver an update. */
export async function steerRunningTurn(
  engine: Pick<Engine, "label" | "capabilities" | "steer">,
  handle: TurnHandle,
  message: () => Parameters<NonNullable<Engine["steer"]>>[1] | Promise<Parameters<NonNullable<Engine["steer"]>>[1]>,
): Promise<void> {
  const mode = engine.capabilities.steer;
  if (!engine.steer || (mode !== "native" && mode !== "concurrent-prompt")) {
    throw new Error(`${engine.label} takes one message at a time`);
  }
  await engine.steer(handle, await message());
}

export type SteerAcknowledgement = { applied: boolean; error?: string };
export type SteerDelivery = { settle(): Promise<void> };

/** One engine call per process-local receipt; transport retries only repeat its immutable outcome. */
export function createSteerDelivery(
  deliver: () => Promise<void>,
  acknowledge: (outcome: SteerAcknowledgement) => Promise<unknown>,
  wait: (ms: number) => Promise<unknown> = (ms) => new Promise((done) => setTimeout(done, ms)),
): SteerDelivery {
  const outcome: Promise<SteerAcknowledgement> = (async () => {
    try {
      await deliver();
      return { applied: true };
    } catch (cause) {
      return { applied: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  })();
  let acknowledged = false;
  let settling: Promise<void> | undefined;
  return {
    settle() {
      if (acknowledged) return Promise.resolve();
      if (settling) return settling;
      settling = (async () => {
        const answer = await outcome;
        for (let attempt = 0; ; attempt++) {
          try {
            await acknowledge(answer);
            acknowledged = true;
            return;
          } catch (cause) {
            if (attempt === 2) throw cause;
            await wait(100 * (attempt + 1));
          }
        }
      })().finally(() => { settling = undefined; });
      return settling;
    },
  };
}
