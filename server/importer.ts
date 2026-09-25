import { readRunnerConfig } from "../runner/home";
import type { Doc } from "./db";
import type { Runtime } from "./runtime";
import { readZip, type ZipEntry } from "./zip";

/**
 * Brings an install's data over from Convex: the zip `npx convex export
 * --include-file-storage` makes, read into this machine's database with every
 * id kept, so everything that points at something still does.
 *
 * What changes on the way:
 *   - Chat history comes from the @convex-dev/agent component's tables into
 *     agentThreads and agentMessages, each thread's messages numbered in order.
 *   - Chats and "always allow" rules move to this computer's runner; the old
 *     runners come along revoked, so their history still reads right.
 *   - Replies and approvals that were still waiting are closed, since the
 *     runner that had them is gone.
 * It replaces what is here, and refuses when this Perry already has chats.
 */

export type ImportSummary = { tables: Record<string, number>; messages: number; threads: number; files: number };

const SKIP = new Set(["codexSteers", "chatgptTokens", "commands", "receipts", "modeConfigs"]);

function jsonl(entry: ZipEntry | undefined): Doc[] {
  if (!entry) return [];
  return entry.read().toString("utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Doc);
}

/** A message's text: its own text field, else the text parts of its content. */
function textOf(message: Doc): string {
  if (typeof message.text === "string") return message.text;
  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
  return "";
}

export async function importConvexExport(runtime: Runtime, path: string, options: { replace?: boolean } = {}): Promise<ImportSummary> {
  const entries = new Map(readZip(path).map((entry) => [entry.name, entry]));
  const docs = (table: string) => jsonl(entries.get(`${table}/documents.jsonl`));
  const tables = Object.keys(runtime.store.tables).filter((table) => entries.has(`${table}/documents.jsonl`) && !SKIP.has(table));
  if (tables.length === 0 && !entries.has("_components/agent/threads/documents.jsonl")) {
    throw new Error("That zip has none of Perry's tables; is it a Convex export of Perry?");
  }

  const token = readRunnerConfig().token;
  const summary: ImportSummary = { tables: {}, messages: 0, threads: 0, files: 0 };
  const now = Date.now();

  await runtime.exclusive(() => {
    const store = runtime.store;
    const hasChats = store.query("conversations").take(1);
    return hasChats.then((found) => {
      if (found.length && !options.replace) throw new Error("This Perry already has chats; importing would replace them. Pass --replace to do it anyway.");
      const localRunner = token ? store.all("runners").find((runner) => runner.token === token) : undefined;
      runtime.sql.exec("BEGIN IMMEDIATE");
      try {
        // What starting the server made (the install row, built-in jobs) gives way to what is imported.
        for (const table of [...tables, "agentThreads", "agentMessages"]) {
          if (table === "runners") continue;
          for (const doc of store.all(table)) store.delete(doc._id);
        }
        for (const table of tables) {
          let count = 0;
          for (const raw of docs(table)) {
            const doc: Doc = { ...raw };
            if (store.tableOf(doc._id)) continue;
            if (table === "runners") { doc.revoked = true; }
            if (table === "conversations" && localRunner && doc.codexRunnerId) doc.codexRunnerId = localRunner._id;
            if (table === "approvalRules" && localRunner) doc.runnerId = localRunner._id;
            if (table === "codexTurns" && (doc.status === "queued" || doc.status === "running")) {
              doc.status = "error";
              doc.error = "Perry moved to this computer while this reply was waiting.";
              doc.finishedAt = now;
            }
            if (table === "approvals" && (doc.status === "pending" || doc.status === "reviewing")) { doc.status = "expired"; doc.decidedAt = now; }
            if (table === "installation") doc.computeTarget = "local";
            if (table === "conversations") doc.pendingTurns = 0;
            store.insert(table, doc, { _id: doc._id, _creationTime: doc._creationTime });
            count++;
          }
          summary.tables[table] = count;
        }

        for (const thread of docs("_components/agent/threads")) {
          if (store.tableOf(thread._id)) continue;
          store.insert("agentThreads", { userId: thread.userId, title: thread.title }, { _id: thread._id, _creationTime: thread._creationTime });
          summary.threads++;
        }
        const byThread = new Map<string, Doc[]>();
        for (const message of docs("_components/agent/messages")) {
          const list = byThread.get(message.threadId as string) ?? [];
          list.push(message);
          byThread.set(message.threadId as string, list);
        }
        for (const [threadId, list] of byThread) {
          if (store.tableOf(threadId) !== "agentThreads") continue;
          list.sort((a, b) => (Number(a.order) - Number(b.order)) || (Number(a.stepOrder ?? 0) - Number(b.stepOrder ?? 0)) || (a._creationTime - b._creationTime));
          let order = 0;
          for (const message of list) {
            const role = (message.message as { role?: string } | undefined)?.role;
            if (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool") continue;
            const text = textOf(message);
            store.insert("agentMessages", {
              threadId,
              ...(message.userId ? { userId: message.userId } : {}),
              order: order++,
              message: { role, content: text },
              text,
              ...(typeof message.provider === "string" ? { provider: message.provider } : {}),
              ...(typeof message.model === "string" ? { model: message.model } : {}),
            }, { _id: message._id, _creationTime: message._creationTime });
            summary.messages++;
          }
        }
        runtime.sql.exec("COMMIT");
      } catch (error) {
        runtime.sql.exec("ROLLBACK");
        throw error;
      }
    });
  });

  // Files last, outside the transaction: they are written to disk.
  for (const file of docs("_storage")) {
    const entry = [...entries.values()].find((item) => item.name.startsWith(`_storage/${file._id}`) && !item.name.endsWith(".jsonl"));
    if (!entry) continue;
    await runtime.importFile(file._id, entry.read(), typeof file.contentType === "string" ? file.contentType : undefined, file._creationTime);
    summary.files++;
  }
  runtime.events.emit("change", [...tables, "agentThreads", "agentMessages"]);
  return summary;
}
