import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Runtime } from "./runtime";

/**
 * What starts a job besides the clock (convex/jobs.ts, onEvent):
 *
 *   - An app's event, from Composio: a new email, a pull request. Composio
 *     sends them over its own websocket (Pusher), so nothing here has to be
 *     reachable from the internet. Subscribed only while a job waits on one.
 *   - A new file in a folder on this computer, watched with fs.watch. A file
 *     counts once it has settled (a download renamed into place, not the
 *     .crdownload while it is written).
 *
 * What should be listened for is read from the jobs whenever they change and
 * every half minute, so a job made, paused or deleted takes effect at once.
 * PERRY_TRIGGER_DRIVER names a module to use instead of Composio, for tests.
 */

type AppEvent = { instanceIds: string[]; event: string };
/** How app events arrive: subscribe, and get back how to stop. */
export type TriggerDriver = { subscribe(apiKey: string | null, onEvent: (event: AppEvent) => void): Promise<() => Promise<void>> };

const RECHECK_MS = 30_000;
/** How long a new file must sit unchanged before it counts. */
const SETTLE_MS = 1_500;
/** An event's details, as far as a run would read them. */
const EVENT_CHARS = 3_000;
/** Names of files still being written, or the system's own. */
const PARTIAL = /\.(crdownload|part|partial|download|tmp|opdownload)$|^~\$|^\.~lock|^desktop\.ini$|^\.DS_Store$|^Thumbs\.db$/i;

const internal = { internal: true };

/** A Composio event, as a run is told about it: what it was, and what came with it. */
function describe(data: { triggerSlug?: string; toolkitSlug?: string; payload?: Record<string, unknown> }): string {
  const body = JSON.stringify(data.payload ?? {}, null, 1);
  return `${data.triggerSlug ?? "An event"}${data.toolkitSlug ? ` from ${data.toolkitSlug}` : ""}\n${body.length > EVENT_CHARS ? `${body.slice(0, EVENT_CHARS)}…` : body}`;
}

async function composioDriver(): Promise<TriggerDriver> {
  const { Composio } = await import("@composio/core");
  return {
    async subscribe(apiKey, onEvent) {
      if (!apiKey) throw new Error("No Composio key.");
      const composio = new Composio({ apiKey });
      await composio.triggers.subscribe(
        (data) => onEvent({ instanceIds: [data.id, data.metadata?.id].filter((id): id is string => Boolean(id)), event: describe(data) }),
        undefined,
        (error) => console.error(`[perry] Composio would not send events: ${JSON.stringify(error).slice(0, 300)}`),
      );
      return async () => { await composio.triggers.unsubscribe(); };
    },
  };
}

async function loadDriver(): Promise<TriggerDriver> {
  const custom = process.env.PERRY_TRIGGER_DRIVER;
  if (custom) return (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(custom).href)).default as TriggerDriver;
  return await composioDriver();
}

/** Watch one folder for new files; `onFile` hears each once it has settled. */
function watchFolder(path: string, onFile: (file: string) => void): FSWatcher | null {
  if (!existsSync(path) || !statSync(path).isDirectory()) return null;
  // What is there already is not new.
  const known = new Set(readdirSync(path));
  const settling = new Map<string, ReturnType<typeof setTimeout>>();
  const watcher = watch(path, (_type, name) => {
    if (!name || PARTIAL.test(name)) return;
    clearTimeout(settling.get(name));
    settling.set(name, setTimeout(() => {
      settling.delete(name);
      const file = join(path, name);
      let isFile = false;
      try { isFile = statSync(file).isFile(); } catch {}
      // Gone again: if it comes back, it is new again.
      if (!isFile) { known.delete(name); return; }
      if (known.has(name)) return;
      known.add(name);
      onFile(file);
    }, SETTLE_MS));
  });
  watcher.on("error", (error) => console.error(`[perry] stopped watching ${path}: ${String(error)}`));
  return watcher;
}

/** Start listening; returns a function that stops it. */
export function runTriggers(runtime: Runtime): () => void {
  let stopped = false;
  const watchers = new Map<string, FSWatcher | null>();
  let subscription: { key: string; close: () => Promise<void> } | null = null;
  let driver: Promise<TriggerDriver> | null = null;
  let busy = false;
  let again = false;

  const onEvent = (args: { instanceIds?: string[]; folder?: string; event: string }) => {
    runtime.runMutation("jobs:onEvent", args, internal)
      .catch((error) => console.error(`[perry] an event could not start its job: ${String(error)}`));
  };

  const reconcile = async () => {
    if (busy) { again = true; return; }
    busy = true;
    try {
      const { folders, apps } = (await runtime.runQuery("jobs:listening", {}, internal)).value as { folders: string[]; apps: number };
      for (const [path, watcher] of watchers) {
        if (!folders.includes(path)) { watcher?.close(); watchers.delete(path); }
      }
      for (const path of folders) {
        // A folder that is not there yet is looked for again next time.
        if (watchers.get(path)) continue;
        const watcher = watchFolder(path, (file) => onEvent({ folder: path, event: `A new file arrived: ${file}` }));
        if (!watcher && !watchers.has(path)) console.error(`[perry] cannot watch ${path}: there is no such folder`);
        watchers.set(path, watcher);
      }

      const key = (await runtime.runQuery("secrets:get", { name: "COMPOSIO_API_KEY" }, internal)).value as string | null;
      const custom = Boolean(process.env.PERRY_TRIGGER_DRIVER);
      const wanted = apps > 0 && (key || custom) ? key ?? "driver" : null;
      if (subscription && subscription.key !== wanted) {
        await subscription.close().catch(() => {});
        subscription = null;
      }
      if (wanted && !subscription && !stopped) {
        driver ??= loadDriver();
        const close = await (await driver).subscribe(key, (event) => onEvent(event));
        subscription = { key: wanted, close };
        console.log("[perry] listening for app events");
      }
    } catch (error) {
      console.error(`[perry] could not listen for events: ${String(error)}`);
    } finally {
      busy = false;
      if (again && !stopped) { again = false; void reconcile(); }
    }
  };

  const onChange = (tables: string[]) => { if (tables.includes("jobs") || tables.includes("secrets")) void reconcile(); };
  runtime.events.on("change", onChange);
  const timer = setInterval(() => void reconcile(), RECHECK_MS);
  void reconcile();

  return () => {
    stopped = true;
    clearInterval(timer);
    runtime.events.off("change", onChange);
    for (const watcher of watchers.values()) watcher?.close();
    void subscription?.close().catch(() => {});
  };
}
