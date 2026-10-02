"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  ActivityIcon, ArrowDownIcon, CopyIcon, FolderIcon, GitBranchIcon, MoreHorizontalIcon, PencilIcon, PinIcon, PinOffIcon, RefreshCwIcon,
  SquarePenIcon, Trash2Icon, TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useAction, useMutation, usePaginatedQuery, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  ACCESS_HINTS, ACCESS_LABELS, ACCESSES, COMPACTED, chatModel, currentModel, describeAccess, describeEfforts, describeModels, effortUnused, findModel,
  modelKey, parseAccessCommand, parseModelCommand, parseModelKey, parseThinkCommand, pickAccess, pickEffort, pickModel, typingSkill, type Access,
} from "@/convex/lib/commands";
import { ENGINE_LABELS, type EngineKind } from "@/convex/lib/engines";
import { limitWarning } from "@/convex/lib/usage";
import { copyText, errorText, useNow } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ACTIVE_CHAT, useSession } from "@/lib/session";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { ApprovalCard } from "../approval-card";
import { DeleteDialog, RenameDialog } from "../app-sidebar";
import { APPS, ChannelIcon, EmptyState, PerryMark, TopBar } from "../common";
import { MoveToProject, NewProjectDialog } from "../projects";
import { useSkills } from "../screens/skills";
import { StatusIndicator } from "../status-indicator";
import { PAUSED_TOAST, usePause } from "../pause";
import type { Attachment } from "./attachments";
import { Composer, ComposerNote, MAX_BYTES, MAX_FILES, levelName, type Suggestion } from "./composer";
import { MessageRow, PendingRow, ReplyInProgress } from "./message";
import { LANDING_MS, SAVED_BEFORE_END_MS, together, type Work } from "./work";

type ChatId = Id<"conversations">;
type PendingAttachment = Attachment & { id: Id<"chatAttachments"> };
/**
 * A message you sent, shown before the server has it: `sent` once sendChat
 * returns, after which the server lists it as pending until its reply saves it.
 */
type Pending = { id: ChatId; text: string; attachments: Attachment[]; baselineCount: number; seenRunning: boolean; sent: boolean };

const STARTERS = [
  "Plan my day",
  "What did we work on this week?",
  "Help me think through an idea",
];

const COMMANDS = [
  { command: "/model", hint: "List the models, or /model <name> to switch this chat" },
  { command: "/think", hint: "List the thinking levels, or /think <level>" },
  { command: "/access", hint: "Ask, Auto or Full access: whether it asks before acting" },
  { command: "/stop", hint: "Stop the reply being written" },
  { command: "/pause", hint: "Pause Perry: stop everything, start nothing new" },
  { command: "/resume", hint: "Start Perry again" },
  { command: "/compact", hint: "Shrink what Perry carries of this chat; the messages stay" },
  { command: "/reset", hint: "Save this chat to memory, then start it afresh" },
];

function greeting(name?: string) {
  const hour = new Date().getHours();
  const part = hour < 5 ? "Up late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name}` : part;
}

/** Keep the file on this machine, through the local media server. */
async function store(file: File): Promise<{ localPath: string }> {
  const local = await fetch("/api/media", { method: "POST", headers: { "x-file-name": encodeURIComponent(file.name) }, body: file });
  if (local.ok) return { localPath: (await local.json() as { path: string }).path };
  throw new Error((await local.json().catch(() => null) as { error?: string } | null)?.error ?? `Could not save ${file.name}.`);
}

export function ChatScreen() {
  const { dashboardKey } = useSession();
  const router = useRouter();
  const params = useParams<{ id?: string }>();
  const paramId = (params.id ? decodeURIComponent(params.id) : null) as ChatId | null;
  /** A chat made from /chat by its first message, until the address catches up. */
  const [createdId, setCreatedId] = useState<ChatId | null>(null);
  useEffect(() => setCreatedId(null), [paramId]);
  const selectedId = paramId ?? createdId;

  const status = useQuery(api.dashboard.getStatus, { key: dashboardKey });
  const assistant = status?.assistantName ?? "Perry";
  const chats = useQuery(api.dashboard.listChats, { key: dashboardKey });
  const summary = chats?.find((item) => item.id === selectedId);
  const parent = chats?.find((item) => item.id === summary?.parentConversationId);
  const chat = useQuery(api.dashboard.getChat, selectedId ? { key: dashboardKey, id: selectedId } : "skip");
  const { results: newest, status: messageStatus, loadMore } = usePaginatedQuery(
    api.dashboard.getChatMessages,
    selectedId ? { key: dashboardKey, id: selectedId } : "skip",
    { initialNumItems: 50 },
  );
  const messages = useMemo(() => [...newest].sort((a, b) => a.createdAt - b.createdAt), [newest]);
  const approvals = useQuery(api.approvals.pending, { key: dashboardKey });
  const now = useNow(1000);
  const here = (approvals ?? []).filter((item) => item.chat?.id === selectedId && item.expiresAt > now);

  const createChat = useMutation(api.dashboard.createChat);
  const sendChat = useMutation(api.dashboard.sendChat);
  const { setPaused } = usePause();
  const stopChat = useMutation(api.dashboard.stopChat);
  const compactChat = useAction(api.dashboard.compactChat);
  const registerAttachment = useMutation(api.dashboard.registerAttachment);
  const markSeen = useMutation(api.dashboard.markChatSeen);
  const skipOnboarding = useMutation(api.dashboard.skipOnboarding);
  const redoOnboarding = useMutation(api.dashboard.redoOnboarding);
  const branchChat = useAction(api.dashboard.branchChat);
  const rewindChat = useAction(api.dashboard.rewindChat);
  const resetChat = useAction(api.dashboard.resetChat);
  const setPinned = useMutation(api.dashboard.setChatPinned);
  const modelOptions = useQuery(api.models.options, { key: dashboardKey });
  const defaultAccess = useQuery(api.dashboard.getDefaultAccess, { key: dashboardKey });
  const lastPicks = useQuery(api.dashboard.getLastPicks, { key: dashboardKey });
  const defaultEngine = useQuery(api.dashboard.getDefaultEngine, { key: dashboardKey });
  const planLimits = useQuery(api.usage.limits, { key: dashboardKey });
  // The heads-up about the engine's limit the owner closed, until it changes.
  const [limitSeen, setLimitSeen] = useState("");
  // The note about Perry moving the chat to another engine the owner closed, by when it moved.
  const [movedSeen, setMovedSeen] = useState(0);
  const setChatModel = useMutation(api.dashboard.setChatModel).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.dashboard.getChat, { key: args.key, id: args.id });
    if (current) store.setQuery(api.dashboard.getChat, { key: args.key, id: args.id }, { ...current, model: args.model, engine: args.engine ?? current.engine });
  });
  const setChatEffort = useMutation(api.dashboard.setChatEffort).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.dashboard.getChat, { key: args.key, id: args.id });
    if (current) store.setQuery(api.dashboard.getChat, { key: args.key, id: args.id }, { ...current, effort: args.effort });
  });
  const setChatAccess = useMutation(api.dashboard.setChatAccess).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.dashboard.getChat, { key: args.key, id: args.id });
    if (current) store.setQuery(api.dashboard.getChat, { key: args.key, id: args.id }, { ...current, access: args.access });
  });

  /**
   * What was picked for a chat not sent yet. Unset carries over the last chat's model and level
   * (and the default access); "" is the default model or level, picked on purpose.
   */
  const [draftModel, setDraftModel] = useState<string>();
  const [draftEngine, setDraftEngine] = useState<EngineKind>();
  const [draftEffort, setDraftEffort] = useState<string>();
  const [draftAccess, setDraftAccess] = useState<Access>();
  const [draft, setDraft] = useState("");
  /** Where the caret is in the draft; unset puts it at the end. */
  const [caret, setCaret] = useState<number>();
  const { skills, refresh: refreshSkills } = useSkills();
  const skillNames = useMemo(() => new Set((skills ?? []).filter((skill) => !skill.problem).map((skill) => skill.name)), [skills]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  /** The /compact being waited on, to say when it is done. */
  const [compaction, setCompaction] = useState<Id<"codexTurns"> | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState<{ index: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  /** A new project is being made for this chat to move into. */
  const [creatingProject, setCreatingProject] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const compactionStatus = useQuery(api.dashboard.getCompaction, compaction ? { key: dashboardKey, id: compaction } : "skip");

  // Remember the open chat, for the next visit to the root.
  useEffect(() => { if (paramId) window.localStorage.setItem(ACTIVE_CHAT, paramId); }, [paramId]);
  useEffect(() => { document.title = summary?.title ? `${summary.title} · Perry` : selectedId ? "Perry" : "New chat · Perry"; }, [summary?.title, selectedId]);
  // A new chat, or another one, starts with a clean composer state.
  useEffect(() => {
    setError(""); setNotice("");
    if (!paramId) window.setTimeout(() => composer.current?.focus(), 0);
  }, [paramId]);
  // Needs you starts an answer here with ?draft=, which is taken in, then out of the address.
  const search = useSearchParams();
  const handed = search.get("draft");
  // A new chat started inside a project (?project=) is in it from its first message.
  const inProject = paramId ? null : search.get("project");
  const newIn = useQuery(api.projects.get, inProject ? { key: dashboardKey, id: inProject } : "skip");
  useEffect(() => {
    if (!handed) return;
    setDraft(handed);
    router.replace("/chat", { scroll: false });
    window.setTimeout(() => composer.current?.focus(), 0);
  }, [handed, router]);

  // What is in an open chat is seen, and so is each reply that lands while it is open and in view.
  useEffect(() => {
    if (!selectedId || !summary?.unseen) return;
    const mark = () => { if (document.visibilityState === "visible") void markSeen({ key: dashboardKey, id: selectedId }).catch(() => {}); };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [selectedId, summary?.unseen, dashboardKey, markSeen]);
  // Opening a chat counts as having seen it, so the first reply after is unseen only if you left.
  useEffect(() => {
    if (selectedId && chat && !chat.isRunning) void markSeen({ key: dashboardKey, id: selectedId }).catch(() => {});
  }, [selectedId, Boolean(chat), chat?.isRunning, dashboardKey, markSeen]);

  // A message you sent stops being shown from here once the server lists it (as pending, or in the history),
  // or once the reply it started or joined has come and gone.
  useEffect(() => {
    setPending((items) => {
      const next = items.filter((item) => item.id !== selectedId
        || messages.filter((message) => message.role === "user" && message.text === item.text).length <= item.baselineCount);
      return next.length === items.length ? items : next;
    });
  }, [messages, selectedId]);
  useEffect(() => {
    const running = chat?.isRunning;
    if (running === undefined) return;
    setPending((items) => {
      let changed = false;
      const next = items.flatMap((item) => {
        if (item.id !== selectedId) return [item];
        if (running && !item.seenRunning) { changed = true; return [{ ...item, seenRunning: true }]; }
        if (item.seenRunning && !running) { changed = true; return []; }
        return [item];
      });
      return changed ? next : items;
    });
  }, [chat?.isRunning, selectedId]);
  useEffect(() => {
    if (!compactionStatus || compactionStatus.status === "queued" || compactionStatus.status === "running") return;
    setNotice(compactionStatus.status === "done" ? COMPACTED : `Could not compact: ${compactionStatus.error ?? "no reason was given."}`);
    setCompaction(null);
  }, [compactionStatus]);

  const shownPending = pending.filter((item) => item.id === selectedId);
  const waiting = shownPending.length > 0 || Boolean(chat?.isRunning);
  // Every step Perry takes: listed as they come while a reply is on its way, and kept with the reply after.
  const work = useQuery(api.dashboard.getChatWork, selectedId ? { key: dashboardKey, id: selectedId } : "skip");
  const { workOf, liveWork } = useMemo(() => {
    const runs = work ?? [];
    const replies = messages.filter((message) => message.role === "assistant" && !message.pending);
    // Each message is a run of its own, and one sent while a reply works joins that reply's turn: several runs
    // can go with one reply. A turn saves its reply before it ends its runs, so a finished run goes with the
    // last reply saved while it ran; a message that waited for a turn of its own then gets that turn's reply.
    const groups = new Map<string, Work[]>();
    for (const run of runs) {
      if (run.status === "running" || run.finishedAt === undefined) continue;
      const reply = [...replies].reverse().find((message) => message.createdAt >= run.startedAt && message.createdAt <= run.finishedAt! + SAVED_BEFORE_END_MS);
      if (reply) groups.set(reply.id, [...groups.get(reply.id) ?? [], run]);
    }
    const workOf = new Map<string, Work>();
    for (const [id, group] of groups) {
      const merged = together(group);
      if (merged?.steps.length) workOf.set(id, merged);
    }
    // A run that ended well and whose reply is not in the chat yet stays up until it is: the two come
    // from different reads, a moment apart, and the steps would blink out in between.
    const paired = new Set([...groups.values()].flat());
    const landing = runs.filter((run) => run.status === "ok" && run.steps.length && !paired.has(run) && now - (run.finishedAt ?? 0) < LANDING_MS);
    return { workOf, liveWork: together([...runs.filter((run) => run.status === "running"), ...landing]) };
  }, [work, messages, now]);

  // Scrolling: a chat opens at its newest message; after that, new content only scrolls into view for a reader already at the bottom.
  const scroller = useRef<HTMLDivElement>(null);
  const olderScroll = useRef<{ height: number; top: number } | null>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  useLayoutEffect(() => { stick.current = true; setAtBottom(true); }, [selectedId]);
  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    stick.current = bottom;
    setAtBottom(bottom);
  }, []);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (olderScroll.current) {
      element.scrollTop = olderScroll.current.top + element.scrollHeight - olderScroll.current.height;
      olderScroll.current = null;
    } else if (stick.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [selectedId, messages.length, shownPending.length, waiting, chat?.streaming, liveWork?.steps.length, here.length]);
  const jumpToLatest = () => {
    stick.current = true;
    setAtBottom(true);
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  const models = modelOptions?.models;
  // The chat's engine; a chat not sent yet is on the owner's default, unless a model was picked for it. None while there is neither.
  const engine: EngineKind | undefined = selectedId ? chat?.engine : draftEngine ?? lastPicks?.engine;
  // Perry never picks an engine for the owner: with none for this chat and no default, it asks (below).
  const noEngine = defaultEngine === null && !engine && !chat?.contact && (!selectedId || chat !== undefined);
  const model = (selectedId ? chat?.model : draftModel ?? lastPicks?.model) || currentModel(models ?? [], undefined, engine);
  // The thinking levels are the model's own; a level it does not take is kept but unused.
  const modelInfo = chatModel(models ?? [], model, engine);
  const efforts = modelInfo?.efforts ?? [];
  const pickedEffort = (selectedId ? chat?.effort : draftEffort ?? lastPicks?.effort) || undefined;
  const effort = modelInfo && effortUnused(modelInfo, pickedEffort) ? undefined : pickedEffort;
  const access: Access = (selectedId ? chat?.access : draftAccess) ?? defaultAccess ?? "supervised";
  // The chat's engine near or at its plan's limit, said before a reply fails for it.
  const engineUsage = planLimits?.engines.find((item) => item.kind === engine)?.usage;
  const limit = chat?.contact || !engine ? null : limitWarning(engine, engineUsage, now);
  const limitMark = limit ? `${engine}:${limit.level}:${limit.title}` : "";
  const fail = (cause: unknown) => setError(errorText(cause));

  /** Pick a model by its "<engine>/<id>" key; another engine's moves the chat there. */
  function applyModel(key: string) {
    const parsed = parseModelKey(key);
    // A bare id is one of the chat's own engine's models.
    const next = { id: parsed.id, engine: parsed.engine ?? engine };
    if (!next.engine) return;
    const picked = models?.find((item) => item.engine === next.engine && item.id === next.id);
    if (picked && pickedEffort && effortUnused(picked, pickedEffort)) {
      setNotice(`${picked.name} doesn't take the ${pickedEffort} thinking level, so it thinks at its default here.`);
    } else if (selectedId && engine && next.engine !== engine) {
      setNotice(`This chat moves to ${ENGINE_LABELS[next.engine]}, which picks up from the chat so far.`);
    }
    if (!selectedId) {
      setDraftEngine(next.engine);
      return setDraftModel(next.id);
    }
    void setChatModel({ key: dashboardKey, id: selectedId, model: next.id || undefined, engine: next.engine }).catch(fail);
  }
  function applyEffort(next: string | undefined) {
    if (!selectedId) return setDraftEffort(next ?? "");
    void setChatEffort({ key: dashboardKey, id: selectedId, effort: next }).catch(fail);
  }
  function applyAccess(next: Access) {
    if (!selectedId) return setDraftAccess(next);
    void setChatAccess({ key: dashboardKey, id: selectedId, access: next }).catch(fail);
  }

  /** Add files from the picker, a paste or a drop, turning away what cannot be sent. */
  function addFiles(added: File[]) {
    if (!added.length) return;
    const tooBig = added.filter((file) => file.size > MAX_BYTES);
    const empty = added.filter((file) => file.size === 0);
    const usable = added.filter((file) => file.size > 0 && file.size <= MAX_BYTES);
    const left = usable.length - Math.max(0, MAX_FILES - files.length);
    const problems = [
      tooBig.length ? `${tooBig.map((file) => file.name).join(", ")} ${tooBig.length === 1 ? "is" : "are"} over 50 MB.` : "",
      empty.length ? `${empty.map((file) => file.name).join(", ")} ${empty.length === 1 ? "is" : "are"} empty.` : "",
      left > 0 ? `Only ${MAX_FILES} files fit in one message, so ${left} ${left === 1 ? "was" : "were"} left out.` : "",
    ].filter(Boolean);
    if (problems.length) setError(problems.join(" "));
    setFiles((items) => [...items, ...usable].slice(0, MAX_FILES));
  }

  // Slash commands: past a command's name, the suggestions are its choices.
  const typedModel = parseModelCommand(draft);
  const typedThink = parseThinkCommand(draft);
  const typedAccess = parseAccessCommand(draft);
  const choosing = /^\/(?:(?:set\s+)?model|think|access)\s/i.test(draft);
  const choices = (options: Array<{ value: string; label: string; hint: string }>, typed: string | undefined, command: string): Suggestion[] =>
    options.filter((option) => !typed || option.value.startsWith(typed)).map((option) => ({
      key: option.value, label: option.label, hint: option.hint, apply: () => void runCommand(`${command} ${option.value}`),
    }));
  // Skills: a $ starts one's name where the caret is, and picking one puts "$name " there.
  const mention = draft.startsWith("/") ? null : typingSkill(draft.slice(0, Math.min(caret ?? draft.length, draft.length)));
  const mentioning = mention !== null;
  // A skill Perry wrote a moment ago is listed too.
  useEffect(() => { if (mentioning) void refreshSkills(); }, [mentioning, refreshSkills]);
  function pickSkill(name: string) {
    if (!mention) return;
    const end = mention.start + 1 + mention.typed.length;
    // The rest of a name the caret was inside is replaced too.
    const after = draft.slice(end).replace(/^[a-z0-9-]*/, "");
    const inserted = `$${name}${after.startsWith(" ") ? "" : " "}`;
    const position = mention.start + inserted.length + (after.startsWith(" ") ? 1 : 0);
    setDraft(draft.slice(0, mention.start) + inserted + after);
    setCaret(position);
    window.setTimeout(() => { composer.current?.focus(); composer.current?.setSelectionRange(position, position); }, 0);
  }
  const skillSuggestions: Suggestion[] = !mention ? [] : (skills ?? [])
    .filter((skill) => !skill.problem && skill.name.includes(mention.typed))
    .sort((a, b) => Number(b.name.startsWith(mention.typed)) - Number(a.name.startsWith(mention.typed)))
    .map((skill) => ({ key: skill.folder, label: `$${skill.name}`, hint: skill.description, typed: skill.name === mention.typed, apply: () => pickSkill(skill.name) }));

  const suggestions: Suggestion[] = !draft.startsWith("/")
    ? skillSuggestions
    : typedModel && choosing
      ? (typedModel.name ? findModel(models ?? [], typedModel.name, engine).matches : models ?? []).map((item) => {
          const key = modelKey(item.engine, item.id);
          const current = item.engine === engine && item.id === model;
          return {
            key, label: item.name, hint: `${key}${current ? " · current" : ""}${item.isDefault ? " · default" : ""}`,
            apply: () => void runCommand(`/model ${key}`),
          };
        })
      : typedThink && choosing
        ? choices([
            { value: "default", label: "Default", hint: `${modelInfo?.defaultEffort ?? "the model's own"}${effort ? "" : " · current"}` },
            ...efforts.map((level) => ({ value: level, label: levelName(level), hint: `${level}${level === effort ? " · current" : ""}` })),
          ], typedThink.level, "/think")
        : typedAccess && choosing
          ? choices(ACCESSES.map((mode) => ({ value: mode, label: ACCESS_LABELS[mode], hint: `${ACCESS_HINTS[mode]}${mode === access ? " · current" : ""}` })), typedAccess.mode, "/access")
          : COMMANDS.filter((item) => item.command.startsWith(draft.trim().toLowerCase()) && draft.trim().length <= item.command.length).map((item) => ({
              key: item.command, label: item.command, hint: item.hint,
              apply: () => { setDraft(["/stop", "/compact", "/reset", "/pause", "/resume"].includes(item.command) ? item.command : `${item.command} `); composer.current?.focus(); },
            }));
  const completing = skillSuggestions.length
    ? "skill" as const
    : draft.startsWith("/") && !choosing
      ? "command" as const
      : choosing && !typedModel && suggestions.length > 0 && !suggestions.some((item) => item.key === (typedThink?.level ?? typedAccess?.mode))
        ? "choice" as const
        : null;

  /** Commands never become messages: they change this chat, then say what they did. */
  async function runCommand(text: string): Promise<boolean> {
    const trimmed = text.trim();
    const modelCommand = parseModelCommand(trimmed);
    if (modelCommand) {
      if (!modelCommand.name) { setDraft(""); setNotice(describeModels(models ?? [], model, engine)); return true; }
      const picked = pickModel(models ?? [], modelCommand.name, pickedEffort, engine);
      // A name that matched nothing, or several models, stays in the box to be fixed.
      if (picked.model) { applyModel(modelKey(picked.model.engine, picked.model.id)); setDraft(""); }
      setNotice(picked.reply);
      return true;
    }
    const thinkCommand = parseThinkCommand(trimmed);
    if (thinkCommand) {
      if (!thinkCommand.level) { setDraft(""); setNotice(describeEfforts(models ?? [], model, pickedEffort, engine)); return true; }
      const picked = pickEffort(models ?? [], model, thinkCommand.level, engine);
      if (picked.ok) { applyEffort(picked.effort); setDraft(""); }
      setNotice(picked.reply);
      return true;
    }
    const accessCommand = parseAccessCommand(trimmed);
    if (accessCommand) {
      if (!accessCommand.mode) { setDraft(""); setNotice(describeAccess(access)); return true; }
      const picked = pickAccess(accessCommand.mode);
      if (picked.access) { applyAccess(picked.access); setDraft(""); }
      setNotice(picked.reply);
      return true;
    }
    const command = trimmed.toLowerCase();
    if (command === "/stop") {
      setDraft("");
      if (selectedId && waiting) await stopChat({ key: dashboardKey, id: selectedId });
      setNotice(selectedId && waiting ? "Stopping." : "Nothing is running.");
      return true;
    }
    if (command === "/pause" || command === "/resume") {
      setDraft("");
      try {
        await setPaused(command === "/pause");
        setNotice(command === "/pause" ? PAUSED_TOAST : "Perry is back on.");
      } catch (cause) { fail(cause); }
      return true;
    }
    if (command === "/reset") {
      setDraft("");
      if (!selectedId) { setNotice("Nothing to reset yet."); return true; }
      setNotice("Saving this chat to memory and starting it afresh…");
      try { setNotice(await resetChat({ key: dashboardKey, id: selectedId })); } catch (cause) { setNotice(""); fail(cause); }
      return true;
    }
    if (command === "/compact") {
      setDraft("");
      try {
        const id = selectedId ? await compactChat({ key: dashboardKey, id: selectedId }) : null;
        setCompaction(id);
        setNotice(id ? "Compacting this chat…" : "Nothing to compact yet.");
      } catch (cause) { setNotice(errorText(cause)); }
      return true;
    }
    return false;
  }

  async function submit(text = draft) {
    const message = text.trim();
    if (message.startsWith("/") && files.length === 0 && await runCommand(message)) return;
    // Sent while a reply is running, the message joins that reply (it steers it).
    if ((!message && files.length === 0) || busy || uploading) return;
    const fresh = !selectedId;
    let id = selectedId;
    if (!id) {
      setBusy(true);
      try {
        id = await createChat({ key: dashboardKey, ...(newIn ? { projectId: newIn.id } : {}) });
        setCreatedId(id);
        // The chat has its own address from now, so a reload while it sends comes back to it.
        router.replace(`/chat/${id}`);
      } catch (cause) {
        fail(cause);
        return;
      } finally {
        setBusy(false);
      }
    }
    const sending = files;
    const messageKey = sending.length ? crypto.randomUUID() : undefined;
    setDraft(""); setFiles([]); setError(""); setNotice("");
    stick.current = true;
    let sent: Pending | undefined;
    try {
      const uploaded: PendingAttachment[] = [];
      for (const [index, file] of sending.entries()) {
        setUploading({ index: index + 1, total: sending.length });
        const contentType = file.type || "application/octet-stream";
        const attachmentId = await registerAttachment({ key: dashboardKey, conversationId: id, messageKey: messageKey!, ...await store(file), fileName: file.name, contentType, size: file.size });
        uploaded.push({ id: attachmentId, url: URL.createObjectURL(file), fileName: file.name, contentType });
      }
      setUploading(null);
      sent = {
        id, text: message, attachments: uploaded,
        baselineCount: fresh ? 0 : messages.filter((item) => item.role === "user" && item.text === message).length,
        seenRunning: !fresh && Boolean(chat?.isRunning), sent: false,
      };
      const entry = sent;
      setPending((items) => [...items, entry]);
      // A new chat takes what was picked before it existed; an existing one already has its own.
      await sendChat({
        key: dashboardKey, id, text: message, attachmentIds: uploaded.map((item) => item.id), messageKey, model, engine,
        ...(fresh ? { effort: pickedEffort ?? "", access: draftAccess } : {}),
      });
      setPending((items) => items.map((item) => item === entry ? { ...item, sent: true } : item));
      // Full access is chosen for a chat, never carried into the next new one.
      if (fresh) setDraftAccess(undefined);
    } catch (cause) {
      setUploading(null);
      setPending((items) => items.filter((item) => item !== sent));
      setDraft(message); setFiles(sending);
      setError(`Your message wasn't sent: ${errorText(cause)}`);
    }
  }

  /** Regenerate from an assistant reply, or resend one of your messages with new text. */
  async function rewind(messageId: string, text?: string) {
    if (!selectedId || busy || waiting) return;
    const index = messages.findIndex((message) => message.id === messageId);
    const source = [...messages.slice(0, index + 1)].reverse().find((message) => message.role === "user");
    const shown = text ?? source?.text ?? "";
    setBusy(true); setError("");
    stick.current = true;
    // The copy being replaced is removed before the new one is listed, so it is not part of the baseline.
    const entry: Pending = {
      id: selectedId, text: shown, attachments: source?.attachments ?? [], seenRunning: false, sent: true,
      baselineCount: messages.filter((message) => message.role === "user" && message.text === shown).length - (source?.text === shown ? 1 : 0),
    };
    try {
      setPending((items) => [...items, entry]);
      await rewindChat({ key: dashboardKey, id: selectedId, messageId, text });
    } catch (cause) {
      setPending((items) => items.filter((item) => item !== entry));
      fail(cause);
    } finally {
      setBusy(false);
    }
  }

  async function branch(messageId: string) {
    if (!selectedId || busy) return;
    setBusy(true); setError("");
    try {
      const id = await branchChat({ key: dashboardKey, id: selectedId, messageId });
      router.push(`/chat/${id}`);
      toast.success("Branched into a new chat.");
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }

  const stop = () => { if (selectedId) void stopChat({ key: dashboardKey, id: selectedId }).catch(fail); };
  // Only what is in the history can be regenerated, edited or branched from.
  const saved = messages.filter((message) => !message.pending);
  const lastUser = [...saved].reverse().find((message) => message.role === "user");
  const lastMessage = saved.at(-1);
  const loading = Boolean(selectedId) && (chat === undefined || messageStatus === "LoadingFirstPage");
  const missing = Boolean(selectedId) && chat === null;
  const title = summary?.title ?? (selectedId ? chat?.title ?? "" : "New chat");
  // A Telegram or WhatsApp chat: written in here too, but what is on the phone cannot be taken back.
  const app = chat && chat.channel !== "web" ? APPS[chat.channel] : null;
  const project = selectedId ? chat?.project : newIn ? { id: newIn.id, name: newIn.name } : undefined;

  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <TopBar actions={selectedId && summary ? (
        <ChatMenu
          pinned={summary.pinned}
          onPin={() => void setPinned({ key: dashboardKey, id: summary.id, pinned: !summary.pinned }).catch(fail)}
          onRename={() => setRenaming(true)}
          onCopyId={() => void copyText(summary.id).then(() => toast.success("Session ID copied."), fail)}
          activityHref={`/settings/activity?session=${summary.id}`}
          onDelete={summary.channel === "web" ? () => setRemoving(true) : undefined}
          move={summary.channel === "web" ? <MoveToProject chat={summary} onNewProject={() => setCreatingProject(true)} /> : null}
        />
      ) : !selectedId ? null : undefined}>
        {/* A project's chat says which, and leads to the project's page. */}
        {project && <>
          <Link href={`/projects/${project.id}`} className="flex min-w-0 shrink items-center gap-1.5 truncate text-muted-foreground hover:text-foreground">
            <FolderIcon className="size-4 shrink-0" aria-hidden /><span className="truncate">{project.name}</span>
          </Link>
          <span className="text-muted-foreground/60" aria-hidden>/</span>
        </>}
        {chat && <ChannelIcon channel={chat.channel} />}
        <h1 className={cn("min-w-0 truncate text-sm font-medium", summary?.naming && "shimmer")} aria-busy={summary?.naming || undefined}>{title}</h1>
        {summary && <StatusIndicator status={summary.status} />}
        {parent && (
          <Link href={`/chat/${parent.id}`} className="hidden min-w-0 items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground sm:flex">
            <GitBranchIcon className="size-3 shrink-0" />from {parent.title}
          </Link>
        )}
      </TopBar>

      <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]" id="content" tabIndex={-1}>
        <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
          {noEngine && (
            <Alert variant="quiet" className="mt-4" role="alert">
              <AlertTitle>Choose the engine {assistant} thinks with</AlertTitle>
              <AlertDescription>{assistant} doesn&apos;t pick one for you. Choose a default for every chat, or pick a model for this one in the box below.</AlertDescription>
              <AlertAction>
                <Button size="sm" render={<Link href="/settings/engines" />}>Choose</Button>
              </AlertAction>
            </Alert>
          )}
          {status?.onboarding === "offer" && (
            <Alert variant="quiet" className="mt-4">
              <AlertTitle>Tell {assistant} about yourself</AlertTitle>
              <AlertDescription>About two minutes.</AlertDescription>
              <AlertAction className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => void skipOnboarding({ key: dashboardKey }).catch(fail)}>Not now</Button>
                <Button size="sm" onClick={() => void redoOnboarding({ key: dashboardKey }).then(() => router.push("/welcome"), fail)}>Start</Button>
              </AlertAction>
            </Alert>
          )}

          {!selectedId ? (
            <div className="flex min-h-[calc(100dvh-16rem)] flex-col items-center justify-center py-12 text-center">
              <PerryMark className="size-14" />
              <h2 className="mt-5 text-3xl font-semibold tracking-[-0.025em] text-balance">{project ? `New chat in ${project.name}` : greeting(status?.displayName)}</h2>
            </div>
          ) : (
            <div className="space-y-8 pt-6 pb-10" aria-busy={loading || undefined}>
              {loading && (
                <div className="space-y-8" role="status" aria-label="Loading the conversation">
                  <Skeleton className="ml-auto h-10 w-1/2 rounded-3xl" />
                  <div className="space-y-2"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-11/12" /><Skeleton className="h-4 w-2/3" /></div>
                </div>
              )}
              {missing && (
                <EmptyState mascot title="This chat isn't here" action={<Button size="sm" render={<Link href="/chat" />}>New chat</Button>}>
                  It may have been deleted.
                </EmptyState>
              )}
              {messageStatus === "CanLoadMore" && (
                <div className="flex justify-center">
                  <Button variant="outline" size="sm" onClick={() => { if (scroller.current) olderScroll.current = { height: scroller.current.scrollHeight, top: scroller.current.scrollTop }; loadMore(50); }}>
                    Load earlier messages
                  </Button>
                </div>
              )}
              {messageStatus === "LoadingMore" && <p className="text-center text-sm text-muted-foreground" role="status">Loading earlier messages…</p>}
              {messages.map((message) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  work={workOf.get(message.id)}
                  assistant={assistant}
                  latest={message.id === lastMessage?.id}
                  canEdit={!waiting && !app}
                  canRegenerate={message.id === lastMessage?.id && !waiting && !app}
                  canBranch={!app}
                  busy={busy}
                  skills={skillNames}
                  onEdit={(text) => void rewind(message.id, text)}
                  onRegenerate={() => void rewind(message.id)}
                  onBranch={() => void branch(message.id)}
                />
              ))}
              {shownPending.map((item, index) => <PendingRow key={index} text={item.text} attachments={item.attachments} sent={item.sent} skills={skillNames} />)}
              {(waiting || liveWork) && !here.length && <ReplyInProgress streaming={chat?.streaming} work={liveWork} now={now} />}
              {here.map((approval) => <ApprovalCard key={approval.id} approval={approval} now={now} showChat={false} />)}
              {chat?.lastError && !chat.isRunning && !waiting && (
                <Alert variant="destructive">
                  <TriangleAlertIcon />
                  <AlertTitle>{assistant} couldn&apos;t finish the last reply</AlertTitle>
                  <AlertDescription>
                    {/too old for Perry|runner|offline|computer/i.test(chat.lastError) && (
                      <p className="mb-1">{/too old for Perry/.test(chat.lastError) ? "Update it with the command below, then try again. Settings → Engines shows it too."
                        : "Your computer may be offline. Start Perry on it, then try again."}</p>
                    )}
                    <p className="font-mono text-xs opacity-80 [overflow-wrap:anywhere]">{chat.lastError.slice(0, 400)}</p>
                  </AlertDescription>
                  {lastUser && !app && (
                    <AlertAction>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void rewind(lastUser.id)}><RefreshCwIcon />Try again</Button>
                    </AlertAction>
                  )}
                </Alert>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="relative shrink-0 px-3 pb-3 sm:px-6 sm:pb-5">
        {!atBottom && selectedId && (
          <div className="pointer-events-none absolute inset-x-0 -top-12 flex justify-center">
            <Button variant="outline" size="sm" className="pointer-events-auto rounded-full bg-background shadow-md" onClick={jumpToLatest}>
              <ArrowDownIcon />{waiting ? "New reply below" : "Jump to latest"}
            </Button>
          </div>
        )}
        <div className="mx-auto w-full max-w-3xl">
          <p className="sr-only" role="status" aria-live="polite">{waiting ? `${assistant} is replying` : ""}</p>
          {chat?.contact ? (
            <div className="px-1 pb-1 text-sm text-muted-foreground" role="note">
              <p className="font-medium text-foreground">{assistant}&apos;s chat with {chat.contact.name}{chat.contact.group ? " (a group)" : ""}</p>
              <p className="mt-1 text-pretty">
                Read only: what you write would reach them. Ask in your own chat to tell them something.
                {" "}<Link href="/settings/people" className="link">What {assistant} may share</Link>
              </p>
            </div>
          ) : (<>
          <Composer
            ref={composer}
            assistant={assistant}
            draft={draft}
            onDraftChange={setDraft}
            onCaret={setCaret}
            onSubmit={() => void submit()}
            onStop={selectedId ? stop : undefined}
            waiting={waiting}
            busy={busy}
            uploading={uploading}
            files={files}
            onAddFiles={addFiles}
            onRemoveFile={(file) => setFiles((items) => items.filter((item) => item !== file))}
            suggestions={suggestions}
            suggesting={mention ? "Skills" : "Commands"}
            completing={completing}
            pickers={{
              models, model: engine && model ? modelKey(engine, model) : undefined, onModel: applyModel, modelInfo, effort, onEffort: applyEffort, access, onAccess: applyAccess,
              accessDisabled: selectedId ? chat === undefined : defaultAccess === undefined,
            }}
            above={<>
              {error && <ComposerNote tone="error" onDismiss={() => setError("")}>{error}</ComposerNote>}
              {notice && <ComposerNote tone="info" onDismiss={() => setNotice("")}>{notice}</ComposerNote>}
              {chat?.moved && movedSeen !== chat.moved.at && (chat.moved.to ?? chat.engine) && (
                <ComposerNote tone="warning" onDismiss={() => setMovedSeen(chat.moved!.at)}>
                  <span className="font-medium">Moved to {ENGINE_LABELS[(chat.moved.to ?? chat.engine)!]}.</span> {chat.moved.why}.{" "}
                  {/* A chat that follows the default goes back by itself; one on an engine of its own, when the owner says. */}
                  {chat.moved.to ? `It goes back to ${ENGINE_LABELS[chat.moved.from]} once that has room.` : `Pick a ${ENGINE_LABELS[chat.moved.from]} model to move it back.`}
                </ComposerNote>
              )}
              {limit && limitSeen !== limitMark && (
                <ComposerNote tone={limit.level === "out" ? "error" : "warning"} onDismiss={() => setLimitSeen(limitMark)}>
                  <span className="font-medium">{limit.title}.</span> {limit.detail}{" "}
                  <Link href="/settings/usage" className="link">See usage</Link>
                </ComposerNote>
              )}
              {!selectedId && !draft && files.length === 0 && (
                <div className="mb-3 flex flex-wrap justify-center gap-2">
                  {STARTERS.map((text) => (
                    <Button key={text} variant="outline" className="h-9 rounded-full px-4 font-normal text-muted-foreground hover:text-foreground" onClick={() => { setDraft(text); composer.current?.focus(); }}>
                      {text}
                    </Button>
                  ))}
                </div>
              )}
            </>}
          />
          <p className="mt-2 text-center text-xs text-muted-foreground">
            {access === "full"
              ? <span className="text-warning">Full access: {assistant} acts on this computer without asking. Every command still shows in Activity.</span>
              : app
                ? <>Your {app} chat. What you write here, and {assistant}&apos;s reply, also go to {app}.</>
                : <>Type <Kbd className="font-mono">/</Kbd> for commands, <Kbd className="font-mono">$</Kbd> for skills.</>}
          </p>
          </>)}
        </div>
      </div>

      {summary && <RenameDialog chat={renaming ? summary : null} onClose={() => setRenaming(false)} />}
      {summary && <DeleteDialog chat={removing ? summary : null} onClose={() => setRemoving(false)} />}
      {summary && <NewProjectDialog open={creatingProject} chat={summary.id} onClose={() => setCreatingProject(false)} />}
    </div>
  );
}

function ChatMenu({ pinned, onPin, onRename, onCopyId, activityHref, onDelete, move }: {
  pinned: boolean; onPin: () => void; onRename: () => void; onCopyId: () => void; activityHref: string; onDelete?: () => void;
  /** Moving it into or out of a project, for a chat that can be in one. */
  move: ReactNode;
}) {
  const router = useRouter();
  return (
    <>
      <Button variant="ghost" size="icon-sm" className="text-muted-foreground md:hidden" aria-label="New chat" render={<Link href="/chat" />}>
        <SquarePenIcon />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Chat options" />}>
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={onPin}>{pinned ? <PinOffIcon /> : <PinIcon />}{pinned ? "Unpin" : "Pin"}</DropdownMenuItem>
          <DropdownMenuItem onClick={onRename}><PencilIcon />Rename</DropdownMenuItem>
          {move}
          <DropdownMenuItem onClick={() => router.push(activityHref)}><ActivityIcon />View activity</DropdownMenuItem>
          <DropdownMenuItem onClick={onCopyId}><CopyIcon />Copy session ID</DropdownMenuItem>
          {onDelete && <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}><Trash2Icon />Delete</DropdownMenuItem>
          </>}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
