import type { Runtime } from "./runtime";

/**
 * Telegram, by long polling: this process asks Telegram for new updates, so no
 * public URL or webhook is needed and nothing listens on the internet for it.
 * While Perry is not running, Telegram keeps a bot's updates for 24 hours and
 * they are handled when it starts again.
 *
 * Each update is handed to ingest.fromTelegram, and only then is its id saved
 * as the next offset, so an update is never lost; one that was being handled
 * as Perry stopped is handled again.
 */

const api = () => (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
const POLL_SECONDS = 30;
const OFFSET_KEY = "telegram.offset";

type Update = { update_id: number } & Record<string, unknown>;
type Reply<T> = { ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

async function call<T>(token: string, method: string, body: object, signal?: AbortSignal): Promise<Reply<T>> {
  const response = await fetch(`${api()}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return await response.json() as Reply<T>;
}

/** Start polling; returns a function that stops it. */
export function pollTelegram(runtime: Runtime): () => void {
  const stop = new AbortController();
  void (async () => {
    let cleared: string | null = null;
    let quietSince = 0;
    while (!stop.signal.aborted) {
      const token = await runtime.runQuery("secrets:get", { name: "TELEGRAM_BOT_TOKEN" }, { internal: true })
        .then((result) => result.value as string | null, () => null);
      if (!token) {
        // No bot; Perry is used from the dashboard. A token saved on the Keys page is picked up here.
        await sleep(15_000, stop.signal);
        continue;
      }
      try {
        // A bot set up for Convex had a webhook, and getUpdates refuses to run while one is set.
        if (cleared !== token) {
          const removed = await call<boolean>(token, "deleteWebhook", { drop_pending_updates: false }, stop.signal);
          if (!removed.ok) throw new Error(removed.description ?? "Telegram refused to remove the old webhook.");
          cleared = token;
          console.log("[perry] Telegram: polling for messages");
        }
        const offset = Number(await runtime.kv.get(OFFSET_KEY) ?? 0) || undefined;
        const reply = await call<Update[]>(token, "getUpdates", {
          offset,
          timeout: POLL_SECONDS,
          allowed_updates: ["message", "edited_message", "callback_query"],
        }, AbortSignal.any([stop.signal, AbortSignal.timeout((POLL_SECONDS + 15) * 1000)]));
        if (!reply.ok) {
          if (reply.error_code === 409) { cleared = null; continue; }
          if (reply.error_code === 401 || reply.error_code === 404) {
            // A token Telegram does not know; wait for a new one rather than hammer it.
            if (Date.now() - quietSince > 600_000) console.error(`[perry] Telegram: ${reply.description ?? "the bot token was refused"}`);
            quietSince = Date.now();
            await sleep(60_000, stop.signal);
            continue;
          }
          await sleep(Math.max(reply.parameters?.retry_after ?? 5, 1) * 1000, stop.signal);
          continue;
        }
        for (const update of reply.result ?? []) {
          await runtime.runAction("ingest:fromTelegram", { update }, { internal: true })
            .catch((error) => console.error(`[perry] Telegram update ${update.update_id} failed: ${error instanceof Error ? error.message : String(error)}`));
          await runtime.kv.set(OFFSET_KEY, String(update.update_id + 1));
        }
      } catch (error) {
        if (stop.signal.aborted) break;
        console.error(`[perry] Telegram: ${error instanceof Error ? error.message : String(error)}; trying again shortly`);
        await sleep(10_000, stop.signal);
      }
    }
  })();
  return () => stop.abort();
}
