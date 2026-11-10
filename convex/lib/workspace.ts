import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { HOME } from "../../runner/home";

/** Membership never makes internal credentials, caches or hidden files browseable. Check symlink targets too. */
export function workspaceSafe(path: string | undefined, name: string): boolean {
  let target = path ? resolve(path) : name;
  try { if (path) target = realpathSync(path); } catch { /* Missing artifacts keep their membership. */ }
  const inHome = relative(HOME, target);
  const parts = (path && !inHome.startsWith("..") ? inHome : target).split(/[\\/]/).filter(Boolean);
  return !parts.some((part) => part.startsWith(".") || /^(node_modules|__pycache__|cache|caches|logs|steps|browser|browser-profiles)$/i.test(part))
    && !/^(cookies(?:\.sqlite)?|login data|web data|credentials(?:\..*)?|secrets?(?:\..*)?|runner\.json|vault(?:\..*)?|.*\.(pem|key|p12|pfx))$/i.test(name);
}

type Association = {
  role: Doc<"workspaceFiles">["role"];
  provenance: Doc<"workspaceFiles">["provenance"];
  messageKey?: string;
  runId?: Id<"runs">;
};

/** Foreground, task and schedule registrations all use the same idempotent association path. */
export async function associate(ctx: MutationCtx, item: Doc<"library">, chat: Doc<"conversations">, source: Association, promote = false): Promise<void> {
  if (chat.contactId || !workspaceSafe(item.localPath, item.name)) return;
  const turnId = source.messageKey?.startsWith("codex-") ? ctx.db.normalizeId("codexTurns", source.messageKey.slice(6)) : null;
  const turn = turnId ? await ctx.db.get(turnId) : null;
  if (turn?.conversationId === chat._id) source = { ...source, runId: turn.runId };
  if (!source.runId && source.provenance === "produced") {
    const active = await ctx.db.query("codexTurns").withIndex("by_conversation_status", (q) => q.eq("conversationId", chat._id).eq("status", "running")).order("desc").first();
    if (active) source = { ...source, runId: active.runId };
  }
  const task = chat.taskId ? await ctx.db.get(chat.taskId) : null;
  const job = chat.jobId ? await ctx.db.get(chat.jobId) : null;
  const originId = task?.origin ?? job?.origin;
  const origin = originId ? await ctx.db.get(originId) : null;
  const scopes = [chat, ...(origin && !origin.contactId && origin._id !== chat._id ? [origin] : [])];
  for (const scope of scopes) {
    const existing = await ctx.db.query("workspaceFiles").withIndex("by_item", (q) => q.eq("conversationId", scope._id).eq("libraryId", item._id)).first();
    if (existing) {
      if (!existing.kind) await ctx.db.patch(existing._id, { kind: item.kind });
      // A deliberately shared result graduates a registered intermediate to a usable output.
      if (promote && existing.role === "working" && source.role !== "working") await ctx.db.patch(existing._id, source);
      continue;
    }
    const related = await ctx.db.query("workspaceFiles").withIndex("by_library", (q) => q.eq("libraryId", item._id)).take(500);
    const projectAlreadyLinked = scope.projectId && related.some((row) => row.projectId === scope.projectId);
    await ctx.db.insert("workspaceFiles", {
      conversationId: scope._id, sourceConversationId: chat._id, libraryId: item._id,
      kind: item.kind,
      ...(scope.projectId && !projectAlreadyLinked ? { projectId: scope.projectId } : {}),
      ...(chat.taskId ? { taskId: chat.taskId } : {}), ...source, createdAt: item.createdAt,
    });
  }
}
