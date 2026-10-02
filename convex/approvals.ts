import { v } from "convex/values";
import { editProposal } from "./compaction";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertDashboardKey } from "./lib/auth";
import { answerCallback, editButtons, sendButtons, type Buttons } from "./lib/telegram";
import { escapeHtml } from "./lib/telegramFormat";
import { authenticate, policyOf, type Policy } from "./runner";
import { targetOf, type Target } from "./channels";
import { presenceOf } from "./todos";
import { readPersona } from "./persona";

/**
 * Approvals for what a runner is asked to do on the owner's machine: a command
 * or file change Codex wants, or a command or write the runner was sent.
 *
 * The runner refuses its hard deny list itself, then records each request
 * here, and this decides in order: a rule the owner saved with "Always allow"
 * runs it; a runner trusted with policy "trust" runs it; with "review" the
 * runner's Codex reviewer looks first and clears what is routine; everything
 * else waits for the owner. The owner is asked in the runner's terminal and
 * the dashboard, and on Telegram or WhatsApp when the conversation it came
 * from speaks there (channels.ts), and whichever answers first wins. One from a
 * web chat or a job reporting to one goes to the owner's messaging app too
 * once they are away from the computer (escalate). A
 * request nobody answers expires, as declined, after APPROVAL_TTL_MS. Every
 * request is recorded, so there is a record of what ran and who allowed it.
 */
export const APPROVAL_TTL_MS = 10 * 60_000;
/** A change to Brain the owner is asked about waits for them: a month, not minutes (compaction.ts). */
export const BRAIN_TTL_MS = 30 * 86_400_000;
const ttlOf = (row: Pick<Doc<"approvals">, "kind">) => (row.kind === "brain" ? BRAIN_TTL_MS : APPROVAL_TTL_MS);
/** With no pet to say whether the owner is at the computer, how long a web request waits before it goes to the phone too. */
const ESCALATE_MS = 2 * 60_000;

const vKind = v.union(v.literal("command"), v.literal("file"), v.literal("write"));
type Kind = "command" | "file" | "write";
type Person = "terminal" | "dashboard" | "telegram" | "whatsapp" | "timeout";

// --- Rules ---------------------------------------------------------------

/** Compare paths the way the owner's filesystem does: Windows ignores case and slash direction. */
function normalPath(path: string): string {
  const slashed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:(\/|$)/i.test(slashed) || slashed.startsWith("//") ? slashed.toLowerCase() : slashed;
}

function inside(path: string, folder: string): boolean {
  const child = normalPath(path);
  const parent = normalPath(folder);
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * The command inside a shell wrapper. Codex on Windows asks about
 * `"...\powershell.exe" -Command "git status"`, and a prefix rule is about
 * the `git status` part.
 */
function innerCommand(command: string): string {
  const trimmed = command.trim();
  const inner = /^(?:"[^"]*(?:powershell|pwsh)(?:\.exe)?"|\S*(?:powershell|pwsh)(?:\.exe)?)\s+(?:-\w+\s+)*?-Command\s+([\s\S]+)$/i.exec(trimmed)?.[1]
    ?? /^(?:"[^"]*cmd(?:\.exe)?"|\S*cmd(?:\.exe)?)\s+(?:\/\w\s+)*?\/c\s+([\s\S]+)$/i.exec(trimmed)?.[1]
    ?? /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/.exec(trimmed)?.[1];
  if (!inner) return trimmed;
  const quoted = /^(["'])([\s\S]*)\1$/.exec(inner.trim());
  return quoted ? quoted[2] : inner.trim();
}

/** Anything that would chain a second command onto an allowed prefix. */
const CHAINED = /[;&|`<>\r\n]|\$\(/;

function startsWithCommand(command: string, prefix: string): boolean {
  const inner = innerCommand(command);
  if (inner !== prefix && !inner.startsWith(`${prefix} `)) return false;
  // "git status" must not also allow "git status; Remove-Item -Recurse ~".
  return !CHAINED.test(inner.slice(prefix.length));
}

/**
 * Codex proposes a command prefix it considers safe to allow from now on
 * (`proposedExecpolicyAmendment`). It becomes the rule only when it really is
 * a prefix of what is being asked; otherwise the rule is the exact command.
 */
function suggestedPrefix(command: string, amendment?: string[]): string | undefined {
  const prefix = amendment?.join(" ").trim();
  if (!prefix || CHAINED.test(prefix)) return undefined;
  const inner = innerCommand(command);
  return inner !== prefix && startsWithCommand(command, prefix) ? prefix : undefined;
}

/** The deepest folder holding every path, unless that is a drive or home-sized root that allows too much. */
function commonFolder(paths: string[]): string | undefined {
  const windows = /^[a-z]:[\\/]/i.test(paths[0] ?? "");
  const same = (a: string, b: string) => windows ? a.toLowerCase() === b.toLowerCase() : a === b;
  const folders = paths.map((path) => path.replace(/\\/g, "/").split("/").slice(0, -1));
  let shared = folders[0] ?? [];
  for (const parts of folders.slice(1)) {
    let i = 0;
    while (i < shared.length && i < parts.length && same(shared[i], parts[i])) i++;
    shared = shared.slice(0, i);
  }
  // C:/Users/me is three parts, and so is /home/me with its empty root.
  if (shared.length < 3) return undefined;
  const folder = shared.join("/");
  return windows ? folder.replace(/\//g, "\\") : folder;
}

type Request = { kind: Kind; title: string; cwd?: string; paths?: string[] };

function alwaysAllowFor(request: Request, amendment?: string[]): Doc<"approvals">["alwaysAllow"] {
  if (request.kind === "command") {
    if (request.title.length > 4000) return undefined;
    const prefix = suggestedPrefix(request.title, amendment);
    return prefix ? { command: prefix, prefix: true } : { command: request.title };
  }
  const folder = request.paths?.length ? commonFolder(request.paths) : undefined;
  return folder ? { pathPrefix: folder } : undefined;
}

function ruleMatches(rule: Doc<"approvalRules">, request: Request): boolean {
  if (request.kind === "command") {
    if (rule.kind !== "command" || !rule.command) return false;
    if (rule.cwd && !(request.cwd && inside(request.cwd, rule.cwd))) return false;
    return rule.prefix ? startsWithCommand(request.title, rule.command) : request.title === rule.command;
  }
  const folder = rule.pathPrefix;
  return rule.kind === "file" && Boolean(folder) && Boolean(request.paths?.length)
    && request.paths!.every((path) => inside(path, folder!));
}

/** What a rule allows, in words, for the dashboard and the Telegram prompt. */
function describeRule(rule: { command?: string; prefix?: boolean; pathPrefix?: string }, cwd?: string): string {
  if (rule.pathPrefix) return `file changes under ${rule.pathPrefix}`;
  const where = cwd ? ` in ${cwd}` : "";
  return rule.prefix ? `commands starting with "${rule.command}"${where}` : `this exact command${where}`;
}

// --- Runner side ---------------------------------------------------------

export const request = mutation({
  args: {
    token: v.string(),
    kind: vKind,
    title: v.string(),
    detail: v.optional(v.string()),
    cwd: v.optional(v.string()),
    paths: v.optional(v.array(v.string())),
    /** Codex's proposed exec-policy amendment: a command prefix it would allow from now on. */
    amendment: v.optional(v.array(v.string())),
    conversationId: v.optional(v.id("conversations")),
  },
  returns: v.object({
    id: v.id("approvals"),
    next: v.union(v.literal("run"), v.literal("review"), v.literal("ask")),
  }),
  handler: async (ctx, args): Promise<{ id: Id<"approvals">; next: "run" | "review" | "ask" }> => {
    const runner = await authenticate(ctx, args.token);
    const now = Date.now();
    const request: Request = { kind: args.kind, title: args.title, cwd: args.cwd, paths: args.paths };
    const row = {
      runnerId: runner._id,
      conversationId: args.conversationId,
      kind: args.kind,
      title: args.title.slice(0, 4000),
      detail: args.detail?.slice(0, 4000),
      cwd: args.cwd,
      paths: args.paths?.slice(0, 50),
      alwaysAllow: alwaysAllowFor(request, args.amendment),
      createdAt: now,
    };

    // The owner already said "always" to this.
    const rules = await ctx.db.query("approvalRules").withIndex("by_runner", (q) => q.eq("runnerId", runner._id)).take(200);
    const rule = rules.find((candidate) => ruleMatches(candidate, request));
    if (rule) {
      await ctx.db.patch(rule._id, { uses: rule.uses + 1, lastUsedAt: now });
      const id = await ctx.db.insert("approvals", { ...row, status: "auto", decidedBy: "rule", ruleId: rule._id, decidedAt: now });
      return { id, next: "run" };
    }

    // The chat's access decides (lib/commands.ts): Ask asks, Auto has Codex review first, Full access runs.
    // Only a request from no chat, sent to the runner itself, follows the computer's own policy.
    const chat = args.conversationId ? await ctx.db.get(args.conversationId) : null;
    const access = chat ? chat.access ?? "supervised" : null;
    const policy: Policy = access === "full" ? "trust" : access === "auto" ? "review" : access === "supervised" ? "ask" : policyOf(runner);
    if (policy === "trust") {
      const id = await ctx.db.insert("approvals", { ...row, status: "auto", decidedBy: "trust", decidedAt: now });
      return { id, next: "run" };
    }
    if (policy === "review") {
      const id = await ctx.db.insert("approvals", { ...row, status: "reviewing" });
      return { id, next: "review" };
    }
    const id = await ctx.db.insert("approvals", { ...row, status: "pending" });
    await ask(ctx, id);
    return { id, next: "ask" };
  },
});

/**
 * The reviewer's verdict. Clear runs it; caution, and any failure, ask the
 * owner, with the verdict shown so they know why.
 */
export const reviewed = mutation({
  args: {
    token: v.string(),
    id: v.id("approvals"),
    verdict: v.union(v.literal("clear"), v.literal("caution"), v.literal("error")),
    reason: v.string(),
    model: v.optional(v.string()),
    ms: v.optional(v.number()),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const runner = await authenticate(ctx, args.token);
    const row = await ctx.db.get(args.id);
    if (row?.runnerId !== runner._id || row.status !== "reviewing") return false;
    const review = { verdict: args.verdict, reason: args.reason.slice(0, 1000), model: args.model, ms: args.ms };
    // The owner may have changed the chat's access while the reviewer looked: Full access runs it, Ask asks.
    const chat = row.conversationId ? await ctx.db.get(row.conversationId) : null;
    const access = chat ? chat.access ?? "supervised" : "auto";
    if (access === "full") {
      await ctx.db.patch(row._id, { status: "auto", decidedBy: "trust", decidedAt: Date.now(), review });
      return true;
    }
    if (args.verdict === "clear" && access === "auto") {
      await ctx.db.patch(row._id, { status: "auto", decidedBy: "reviewer", decidedAt: Date.now(), review });
      return true;
    }
    await ctx.db.patch(row._id, { status: "pending", review });
    await ask(ctx, row._id);
    return false;
  },
});

/** The runner watches its request here, to hear an answer from the dashboard or Telegram. */
export const decision = query({
  args: { token: v.string(), id: v.id("approvals") },
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const row = await ctx.db.get(args.id);
    return row?.runnerId === runner._id ? row.status : null;
  },
});

/**
 * Settle a pending request, once. "Always allow" saves a rule, but only with
 * a yes; a decline is never remembered. A Telegram prompt is edited to show
 * the outcome, whichever side answered.
 */
async function settleRow(ctx: MutationCtx, row: Doc<"approvals">, answer: { approved: boolean; by: Person; always?: boolean }) {
  const now = Date.now();
  const offer = answer.approved && answer.always && answer.by !== "timeout" ? row.alwaysAllow : undefined;
  const ruleId = offer
    ? await ctx.db.insert("approvalRules", {
      runnerId: row.runnerId,
      kind: row.kind === "command" ? "command" : "file",
      command: offer.command,
      prefix: offer.prefix,
      cwd: row.kind === "command" ? row.cwd : undefined,
      pathPrefix: offer.pathPrefix,
      uses: 0,
      createdFrom: row._id,
      createdAt: now,
    })
    : undefined;
  await ctx.db.patch(row._id, {
    status: answer.by === "timeout" ? "expired" : answer.approved ? "approved" : "declined",
    decidedBy: answer.by,
    decidedAt: now,
    ...(ruleId ? { ruleId } : {}),
  });
  // A change to Brain, made or not (compaction.ts).
  if (row.kind === "brain" && row.proposalId) {
    await ctx.scheduler.runAfter(0, internal.compaction.decided, { id: row.proposalId, approved: answer.approved && answer.by !== "timeout", ...(answer.by === "timeout" ? { expired: true } : {}) });
  }
  // Someone Perry may now talk with, or not (contacts.ts).
  if ((row.kind === "contact" || row.kind === "message") && row.contactId) {
    await ctx.scheduler.runAfter(0, internal.contacts.decided, { contactId: row.contactId, kind: row.kind, approved: answer.approved && answer.by !== "timeout", ...(answer.by === "timeout" ? { expired: true } : {}) });
  }
  if (row.telegramMessageId) await ctx.scheduler.runAfter(0, internal.approvals.showOutcomeOnTelegram, { id: row._id });
}

/**
 * A chat's access changed. Put on Full access, what it is still waiting on
 * the owner for runs now, as it would have had it been asked after; the
 * prompts on the phone are edited to say so. Ask and Auto leave the owner
 * asked: waiting on them is the strictest there is.
 */
export async function accessChanged(ctx: MutationCtx, conversationId: Id<"conversations">, access: Doc<"conversations">["access"]) {
  if (access !== "full") return;
  const pending = await ctx.db.query("approvals").withIndex("by_status", (q) => q.eq("status", "pending")).take(200);
  const now = Date.now();
  for (const row of pending) {
    if (row.conversationId !== conversationId) continue;
    await ctx.db.patch(row._id, { status: "auto", decidedBy: "trust", decidedAt: now });
    if (row.telegramMessageId) await ctx.scheduler.runAfter(0, internal.approvals.showOutcomeOnTelegram, { id: row._id });
  }
}

const answerable = (row: Doc<"approvals">) =>
  row.status === "pending" && row.createdAt >= Date.now() - ttlOf(row);

/** The runner records an answer given in its terminal, or a timeout. */
export const settle = mutation({
  args: {
    token: v.string(),
    id: v.id("approvals"),
    approved: v.boolean(),
    by: v.union(v.literal("terminal"), v.literal("timeout")),
    always: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const row = await ctx.db.get(args.id);
    // A timeout settles a request even at the very end of its life.
    if (row?.runnerId !== runner._id || row.status !== "pending") return null;
    await settleRow(ctx, row, { approved: args.approved, by: args.by, always: args.always });
    return null;
  },
});

// --- Perry's browser ---------------------------------------------------

/**
 * A step in Perry's own browser that buys, sends, posts or the like (tools.ts,
 * browser). Asked like a command: where the chat speaks, on the pet, and on
 * the phone when the owner is away; a chat with Full access goes ahead. The
 * tool waits for the answer (decisionOf).
 */
export const askForBrowser = internalMutation({
  args: { conversationId: v.optional(v.id("conversations")), title: v.string(), detail: v.optional(v.string()) },
  returns: v.object({ id: v.id("approvals"), status: v.string() }),
  handler: async (ctx, args) => {
    const chat = args.conversationId ? await ctx.db.get(args.conversationId) : null;
    const runnerId = chat?.codexRunnerId ?? (await ctx.db.query("runners").first())?._id;
    if (!runnerId) throw new Error("No computer is connected to ask on.");
    const now = Date.now();
    const row = { runnerId, conversationId: args.conversationId, kind: "browser" as const, title: args.title.slice(0, 500), detail: args.detail?.slice(0, 1000), createdAt: now };
    if (chat?.access === "full") {
      const id = await ctx.db.insert("approvals", { ...row, status: "auto", decidedBy: "trust", decidedAt: now });
      return { id, status: "auto" };
    }
    const id = await ctx.db.insert("approvals", { ...row, status: "pending" });
    await ask(ctx, id);
    return { id, status: "pending" };
  },
});

/** Where a browser step's request stands; one nobody answered in time is settled as expired. */
export const decisionOf = internalMutation({
  args: { id: v.id("approvals") },
  returns: v.string(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row) return "declined";
    if (row.status === "pending" && row.createdAt < Date.now() - APPROVAL_TTL_MS) {
      await settleRow(ctx, row, { approved: false, by: "timeout" });
      return "expired";
    }
    return row.status;
  },
});

// --- Other people ----------------------------------------------------------

/**
 * Someone new wrote to Perry ("contact"), or Perry wants to write to someone
 * it has not talked with ("message"): asked like a command, where the owner
 * is (never in the chat with that person), and answered once for good
 * (contacts.decided). No computer is involved, but a request belongs to a
 * runner, so it is the one there is; with none, nothing can be asked, and
 * this returns null.
 */
export async function askAboutContact(ctx: MutationCtx, args: { kind: "contact" | "message"; contactId: Id<"contacts">; title: string; detail?: string; conversationId?: Id<"conversations"> }): Promise<Id<"approvals"> | null> {
  const runnerId = (await ctx.db.query("runners").first())?._id;
  if (!runnerId) return null;
  const id = await ctx.db.insert("approvals", {
    runnerId, kind: args.kind, contactId: args.contactId, title: args.title.slice(0, 900), detail: args.detail?.slice(0, 1000),
    ...(args.conversationId ? { conversationId: args.conversationId } : {}),
    status: "pending", createdAt: Date.now(),
  });
  await ask(ctx, id);
  return id;
}

/**
 * A change to Brain Perry proposes (compaction.ts): asked like a contact is,
 * with what it would change and what would stand instead, and answered once.
 * It belongs to a runner as every request does, the first there is; with none
 * it is not asked here, and waits in Brain.
 */
export async function askAboutBrain(ctx: MutationCtx, args: { proposalId: Id<"brainProposals">; title: string; detail: string }): Promise<Id<"approvals"> | null> {
  const runnerId = (await ctx.db.query("runners").first())?._id;
  if (!runnerId) return null;
  const id = await ctx.db.insert("approvals", {
    runnerId, kind: "brain", proposalId: args.proposalId, title: args.title.slice(0, 900), detail: args.detail.slice(0, 4000),
    status: "pending", createdAt: Date.now(),
  });
  await ask(ctx, id);
  return id;
}

// --- Asking the owner ---------------------------------------------------

/** Ask where the request's conversation speaks, and see whether the owner is around to answer it there. */
async function ask(ctx: MutationCtx, id: Id<"approvals">) {
  await ctx.scheduler.runAfter(0, internal.approvals.promptOnTelegram, { id });
  await ctx.scheduler.runAfter(0, internal.approvals.promptOnWhatsApp, { id });
  await ctx.scheduler.runAfter(0, internal.approvals.escalate, { id });
}

/**
 * A request from a web chat (or a job reporting to one) is asked there and on
 * the pet. When the owner is away from the computer, it goes to their
 * messaging app too, as a to-do reminder does: at once when the pet says they
 * have stepped away, or, with no pet running to say, once it has waited
 * ESCALATE_MS unanswered. While the pet sees them at the computer, it stays
 * there. The first answer anywhere settles it.
 */
export const escalate = internalMutation({
  args: { id: v.id("approvals"), late: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row || !answerable(row) || row.telegramMessageId || row.whatsappChatId) return null;
    if ((await targetOf(ctx, row.conversationId))?.channel !== "web") return null;
    const phone = await targetOf(ctx);
    if (!phone || phone.channel === "web") return null;
    const presence = await presenceOf(ctx);
    if (presence === "away" || (presence === "unknown" && args.late)) {
      await ctx.scheduler.runAfter(0, phone.channel === "telegram" ? internal.approvals.promptOnTelegram : internal.approvals.promptOnWhatsApp, { id: row._id, home: true });
      return null;
    }
    // Look again in a while, until it is answered or expires: the owner may walk away.
    await ctx.scheduler.runAfter(args.late ? 60_000 : ESCALATE_MS, internal.approvals.escalate, { id: row._id, late: true });
    return null;
  },
});

// --- Telegram ------------------------------------------------------------

const ASK = { command: "run", file: "change files", write: "write a file", browser: "do this in its browser", contact: "talk with someone new", message: "message someone", brain: "tidy Brain" } as const;
/** Who is asking: the computer for what runs on it, Perry itself for talking with people. */
const asker = async (ctx: QueryCtx, row: Doc<"approvals">) =>
  row.kind === "contact" || row.kind === "message" || row.kind === "brain" ? (await readPersona(ctx)).name : (await ctx.db.get(row.runnerId))?.name;

type View = Doc<"approvals"> & { runner: string; chat?: string };

export const view = internalQuery({
  args: { id: v.id("approvals") },
  handler: async (ctx, args): Promise<View | null> => {
    const row = await ctx.db.get(args.id);
    if (!row) return null;
    const chat = row.conversationId ? await ctx.db.get(row.conversationId) : null;
    return { ...row, runner: (await asker(ctx, row)) ?? "A runner", chat: chat?.title };
  },
});

function promptText(row: View): string {
  return [
    `${row.runner} wants to ${ASK[row.kind]}${row.chat ? ` (${row.chat})` : ""}:`,
    row.title.slice(0, 1500),
    row.cwd ? `in ${row.cwd}` : null,
    row.detail ? row.detail.slice(0, 800) : null,
    row.review ? `Reviewer: ${row.review.verdict}. ${row.review.reason}` : null,
    row.alwaysAllow ? `Always allow saves a rule for ${describeRule(row.alwaysAllow, row.cwd)}.` : null,
  ].filter(Boolean).join("\n\n");
}

/** The same prompt as Telegram HTML: what it wants in bold, the command as code, where in monospace. */
function promptHtml(row: View, outcome?: string): string {
  return [
    `🔐 <b>${escapeHtml(row.runner)} wants to ${ASK[row.kind]}</b>${row.chat ? ` · <i>${escapeHtml(row.chat)}</i>` : ""}`,
    `<pre>${escapeHtml(row.title.slice(0, 1500))}</pre>`,
    row.cwd ? `📁 <code>${escapeHtml(row.cwd)}</code>` : null,
    row.detail ? escapeHtml(row.detail.slice(0, 800)) : null,
    row.review ? `<i>Reviewer: ${escapeHtml(row.review.verdict)}. ${escapeHtml(row.review.reason)}</i>` : null,
    row.alwaysAllow && !outcome ? `<i>Always allow saves a rule for ${escapeHtml(describeRule(row.alwaysAllow, row.cwd))}.</i>` : null,
    outcome ? `<b>${escapeHtml(outcome)}</b>` : null,
  ].filter(Boolean).join("\n\n");
}

const WHERE = { terminal: " in the terminal", dashboard: " in the dashboard", telegram: " on Telegram", whatsapp: " on WhatsApp" } as const;

function outcomeText(row: View): string {
  const where = row.decidedBy && row.decidedBy in WHERE ? WHERE[row.decidedBy as keyof typeof WHERE] : "";
  if (row.status === "approved") return `Approved${where}${row.ruleId ? ", and always allowed from now on" : ""}.`;
  if (row.status === "declined") return `Declined${where}.`;
  if (row.status === "expired") return "Nobody answered in time, so it was declined.";
  if (row.status === "auto" && row.decidedBy === "trust") return "Allowed: the chat is on Full access now.";
  return "Answered.";
}

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/public/channels/telegram/hitl.ts
/** Approve and Decline side by side, and Always allow under them when the request can be remembered. */
function buttonsFor(row: View): Buttons {
  const rows: Buttons = [[{ text: "Approve", data: `ap:${row._id}:y` }, { text: "Decline", data: `ap:${row._id}:n` }]];
  if (row.alwaysAllow) rows.push([{ text: "Always allow", data: `ap:${row._id}:a` }]);
  return rows;
}

/**
 * Ask the owner on Telegram, where the request's conversation speaks
 * (channels.ts): its Telegram chat, or for a job the chat it was set up in or
 * the messaging channel. A request from a web chat is asked there only, so
 * talking on the web brings nothing to Telegram. The owner can turn this off.
 */
export const promptOnTelegram = internalAction({
  args: { id: v.id("approvals"), home: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const install = await ctx.runQuery(internal.installation.get, {});
    if (!install?.claimedAt || !install.ownerExternalId || install.ownerChannel !== "telegram") return null;
    if (install.telegramApprovals === false) return null;
    const row = await ctx.runQuery(internal.approvals.view, { id: args.id });
    if (row?.status !== "pending" || row.telegramMessageId) return null;
    const target: Target | null = await ctx.runQuery(internal.channels.target, { conversationId: args.home ? undefined : row.conversationId });
    if (target?.channel !== "telegram" || target.externalId !== install.ownerExternalId) return null;
    try {
      const token: string | null = await ctx.runQuery(internal.secrets.get, { name: "TELEGRAM_BOT_TOKEN" });
      const messageId = await sendButtons(token, install.ownerExternalId, promptText(row), buttonsFor(row), promptHtml(row));
      await ctx.runMutation(internal.approvals.promptSent, { id: args.id, chatId: install.ownerExternalId, messageId });
    } catch (error) {
      console.error(`could not ask on Telegram: ${String(error)}`);
    }
    return null;
  },
});

export const promptSent = internalMutation({
  args: { id: v.id("approvals"), chatId: v.string(), messageId: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row) return null;
    await ctx.db.patch(row._id, { telegramChatId: args.chatId, telegramMessageId: args.messageId });
    // Answered somewhere else while the prompt was on its way.
    if (row.status !== "pending") await ctx.scheduler.runAfter(0, internal.approvals.showOutcomeOnTelegram, { id: row._id });
    return null;
  },
});

/** Rewrite the prompt with the outcome and take its buttons away, so it cannot be answered twice. */
export const showOutcomeOnTelegram = internalAction({
  args: { id: v.id("approvals") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.runQuery(internal.approvals.view, { id: args.id });
    if (!row?.telegramChatId || !row.telegramMessageId || row.status === "pending") return null;
    try {
      const token: string | null = await ctx.runQuery(internal.secrets.get, { name: "TELEGRAM_BOT_TOKEN" });
      await editButtons(token, row.telegramChatId, row.telegramMessageId, `${promptText(row)}\n\n${outcomeText(row)}`, [], promptHtml(row, outcomeText(row)));
    } catch (error) {
      console.error(`could not update the Telegram prompt: ${String(error)}`);
    }
    return null;
  },
});

/**
 * A tap on an approval button: `ap:<approval id>:y|n|a`. The id in the button
 * is not a credential; only the stored owner's tap counts. Returns the note
 * shown on the owner's phone.
 */
export const answerFromTelegram = internalMutation({
  args: { senderId: v.string(), data: v.string() },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const install = await ctx.db.query("installation").unique();
    if (!install?.claimedAt || install.ownerChannel !== "telegram" || install.ownerExternalId !== args.senderId) {
      return "Only the owner can answer this.";
    }
    const match = /^ap:([a-z0-9]+):([yna])$/.exec(args.data);
    const id = match ? ctx.db.normalizeId("approvals", match[1]) : null;
    if (!match || !id) return "That button is not recognised.";
    const row = await ctx.db.get(id);
    if (!row) return "That request is gone.";
    if (row.status === "pending" && !answerable(row)) {
      // Its runner never came back to time it out; close it, and its buttons, now.
      await settleRow(ctx, row, { approved: false, by: "timeout" });
      return "That request has expired.";
    }
    if (!answerable(row)) return "That was already answered.";
    const choice = match[2];
    await settleRow(ctx, row, { approved: choice !== "n", by: "telegram", always: choice === "a" });
    return choice === "n" ? "Declined." : choice === "a" && row.alwaysAllow ? "Approved, and always allowed." : "Approved.";
  },
});

/**
 * Ask the owner on WhatsApp, where the request's conversation speaks there
 * (channels.ts). WhatsApp has no buttons for an ordinary account, so the
 * answer is a reply: 1, 2 or 3 (answerFromWhatsApp).
 */
export const promptOnWhatsApp = internalAction({
  args: { id: v.id("approvals"), home: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.runQuery(internal.approvals.view, { id: args.id });
    if (row?.status !== "pending" || row.whatsappChatId) return null;
    const target: Target | null = await ctx.runQuery(internal.channels.target, { conversationId: args.home ? undefined : row.conversationId });
    if (target?.channel !== "whatsapp") return null;
    const fence = "```";
    const ask = [
      `🔐 **${row.runner} wants to ${ASK[row.kind]}**${row.chat ? ` · _${row.chat}_` : ""}`,
      `${fence}\n${row.title.slice(0, 1500)}\n${fence}`,
      row.cwd ? `📁 \`${row.cwd}\`` : null,
      row.detail ? row.detail.slice(0, 800) : null,
      row.review ? `_Reviewer: ${row.review.verdict}. ${row.review.reason}_` : null,
      `Reply **1** to approve, **2** to decline${row.alwaysAllow ? `, **3** to always allow (${describeRule(row.alwaysAllow, row.cwd)})` : ""}.`,
    ].filter(Boolean).join("\n\n");
    if (await ctx.runMutation(internal.whatsapp.send, { to: target.externalId, text: ask })) {
      await ctx.runMutation(internal.approvals.askedOnWhatsApp, { id: args.id, chatId: target.externalId });
    }
    return null;
  },
});

export const askedOnWhatsApp = internalMutation({
  args: { id: v.id("approvals"), chatId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (await ctx.db.get(args.id)) await ctx.db.patch(args.id, { whatsappChatId: args.chatId });
    return null;
  },
});

/**
 * A reply in a WhatsApp chat where an approval is waiting: 1 (or yes) approves,
 * 2 (or no) declines, 3 (or always) approves and saves the rule. Anything else
 * is not an answer and goes to the assistant. Returns what to tell the owner.
 */
export const answerFromWhatsApp = internalMutation({
  args: { chatId: v.string(), text: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args): Promise<string | null> => {
    const word = args.text.trim().toLowerCase().replace(/[.!]+$/, "");
    const choices: Record<string, "y" | "n" | "a"> = { "1": "y", yes: "y", y: "y", approve: "y", "2": "n", no: "n", n: "n", decline: "n", "3": "a", always: "a" };
    const choice = choices[word];
    if (!choice) return null;
    const waiting = (await ctx.db.query("approvals").withIndex("by_status", (q) => q.eq("status", "pending")).order("desc").take(50))
      .find((row) => row.whatsappChatId === args.chatId);
    if (!waiting) return null;
    if (!answerable(waiting)) {
      await settleRow(ctx, waiting, { approved: false, by: "timeout" });
      return "That request had expired, so it was declined.";
    }
    await settleRow(ctx, waiting, { approved: choice !== "n", by: "whatsapp", always: choice === "a" });
    return choice === "n" ? "Declined." : choice === "a" && waiting.alwaysAllow ? "Approved, and always allowed from now on." : "Approved.";
  },
});

/** Clear the tapped button's spinner. Cosmetic, so a failure is only logged. */
export const acknowledgeTap = internalAction({
  args: { callbackId: v.string(), note: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      const token: string | null = await ctx.runQuery(internal.secrets.get, { name: "TELEGRAM_BOT_TOKEN" });
      await answerCallback(token, args.callbackId, args.note);
    } catch (error) {
      console.warn(`could not acknowledge a button tap: ${String(error)}`);
    }
    return null;
  },
});

// --- Dashboard -----------------------------------------------------------

type Review = NonNullable<Doc<"approvals">["review"]>;

export type PendingApproval = {
  id: Id<"approvals">;
  kind: Doc<"approvals">["kind"];
  title: string;
  detail?: string;
  cwd?: string;
  runner: string;
  chat?: { id: Id<"conversations">; title: string };
  review?: Review;
  /** What "Always allow" would save, in words. Unset means it cannot be remembered. */
  alwaysAllow?: string;
  /** A change to Brain: the lines now, and the lines after, which the owner may edit before approving. */
  proposal?: { kind: string; before: string[]; after: string[]; page?: { id: Id<"notes">; title: string } };
  createdAt: number;
  expiresAt: number;
};

/** What is waiting for the owner, newest first. */
export const pending = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<PendingApproval[]> => {
    assertDashboardKey(args.key);
    const rows = (await ctx.db.query("approvals")
      .withIndex("by_status", (q) => q.eq("status", "pending").gt("createdAt", Date.now() - BRAIN_TTL_MS))
      .order("desc")
      .take(60))
      .filter((row) => row.createdAt > Date.now() - ttlOf(row))
      .slice(0, 20);
    return await Promise.all(rows.map(async (row) => {
      const runner = await asker(ctx, row);
      const chat = row.conversationId ? await ctx.db.get(row.conversationId) : null;
      const proposal = row.proposalId ? await ctx.db.get(row.proposalId) : null;
      const page = proposal ? await ctx.db.get(proposal.rollupPageId ?? proposal.pageId) : null;
      return {
        id: row._id,
        kind: row.kind,
        title: row.title,
        detail: row.detail,
        cwd: row.cwd,
        runner: runner ?? "a runner",
        chat: chat ? { id: chat._id, title: chat.title ?? "Untitled chat" } : undefined,
        review: row.review,
        alwaysAllow: row.alwaysAllow ? describeRule(row.alwaysAllow, row.cwd) : undefined,
        ...(proposal ? { proposal: { kind: proposal.kind, before: proposal.before.map((line) => line.text), after: proposal.after, ...(page ? { page: { id: page._id, title: page.title } } : {}) } } : {}),
        createdAt: row.createdAt,
        expiresAt: row.createdAt + ttlOf(row),
      };
    }));
  },
});

/** The owner's answer from the dashboard. First answer wins. */
export const decide = mutation({
  args: {
    key: v.string(), id: v.id("approvals"), approved: v.boolean(), always: v.optional(v.boolean()),
    /** A change to Brain approved with the owner's own words for what the lines become. */
    edited: v.optional(v.array(v.string())),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const row = await ctx.db.get(args.id);
    if (!row || !answerable(row)) return false;
    if (args.approved && args.edited && row.kind === "brain" && row.proposalId && !await editProposal(ctx, row.proposalId, args.edited)) return false;
    await settleRow(ctx, row, { approved: args.approved, by: "dashboard", always: args.always });
    return true;
  },
});

export type DecidedApproval = {
  id: Id<"approvals">;
  kind: Doc<"approvals">["kind"];
  title: string;
  cwd?: string;
  runner: string;
  status: Doc<"approvals">["status"];
  decidedBy?: Doc<"approvals">["decidedBy"];
  review?: Review;
  ruleId?: Id<"approvalRules">;
  createdAt: number;
  decidedAt?: number;
};

/** What was asked lately and how each was settled, including what ran without asking. */
export const recent = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<DecidedApproval[]> => {
    assertDashboardKey(args.key);
    const rows = await ctx.db.query("approvals").order("desc").take(25);
    const names = new Map<Id<"runners">, string>();
    for (const row of rows) {
      if (!names.has(row.runnerId)) names.set(row.runnerId, (await ctx.db.get(row.runnerId))?.name ?? "a runner");
    }
    return rows.map((row) => ({
      id: row._id,
      kind: row.kind,
      title: row.title,
      cwd: row.cwd,
      runner: names.get(row.runnerId)!,
      status: row.status,
      decidedBy: row.decidedBy,
      review: row.review,
      ruleId: row.ruleId,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
    }));
  },
});

export type ApprovalRule = {
  id: Id<"approvalRules">;
  runner: string;
  kind: "command" | "file";
  command?: string;
  prefix: boolean;
  cwd?: string;
  pathPrefix?: string;
  description: string;
  uses: number;
  lastUsedAt?: number;
  createdAt: number;
};

/** Everything the owner has said to always allow, on every runner. */
export const rules = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<ApprovalRule[]> => {
    assertDashboardKey(args.key);
    const rows = await ctx.db.query("approvalRules").order("desc").take(200);
    return await Promise.all(rows.map(async (rule) => ({
      id: rule._id,
      runner: (await ctx.db.get(rule.runnerId))?.name ?? "a runner",
      kind: rule.kind,
      command: rule.command,
      prefix: Boolean(rule.prefix),
      cwd: rule.cwd,
      pathPrefix: rule.pathPrefix,
      description: describeRule(rule, rule.cwd),
      uses: rule.uses,
      lastUsedAt: rule.lastUsedAt,
      createdAt: rule.createdAt,
    })));
  },
});

/** Forget a rule. The next matching request is asked again. */
export const deleteRule = mutation({
  args: { key: v.string(), id: v.id("approvalRules") },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    if (await ctx.db.get(args.id)) await ctx.db.delete(args.id);
    return null;
  },
});
