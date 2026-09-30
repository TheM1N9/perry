"use client";

import {
  BookOpenIcon, BrainIcon, CheckIcon, ExternalLinkIcon, HourglassIcon, InboxIcon, ListTodoIcon, MessageCircleIcon, MoonIcon, NotebookPenIcon,
  PaletteIcon, PencilIcon, SearchIcon, TerminalIcon, XIcon, type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion, useAnimationControls, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Activity } from "@/convex/dashboard";
import type { Pose } from "@/convex/lib/activity";
import type { Board, TodoView } from "@/convex/todos";
import { errorText, plural, useNow } from "@/lib/format";
import { KEY_STORAGE, SessionContext, useDashboardKey } from "@/lib/session";
import { cn } from "@/lib/utils";
import { countdown, dueLabel } from "@/lib/when";
import { PlatypusArt } from "@/components/dashboard/platypus";
import { updateReady, useUpdates } from "@/components/dashboard/updates";
import { QuickAdd, StreakBadge, TodoRows } from "@/components/todos/todos";
import { PetChat, keepPicture, type PetChatId, type Shot, type TakenShot } from "./chat";
import { Empty } from "./empty";
import { PetNeedsYou } from "./needs-you";
import { useVoice, type HotkeyState, type VoiceBridge } from "./voice";

/**
 * Perry on the desktop: the platypus, standing in a corner of the screen on
 * top of everything, and a small Perry a click away: your chats with him,
 * with all he knows; your to-dos; and what is waiting on you, answered right
 * there. He speaks up for what matters now: a computer waiting for your yes,
 * a to-do coming due (at 15 and 10 minutes, then a countdown held for the
 * last five until it is done or pushed back), a reply you have not read, a
 * chat with something new. Talk to him with a hotkey from anywhere, or his
 * mic button; what you say goes into his chat (voice.tsx, pet/voice.js).
 * With nothing going on he naps, hat off. He tells the server when the owner
 * is away, and the phone gets the reminders instead (convex/todos.ts).
 *
 * This page is what the pet's window shows (pet/main.js): a transparent,
 * frameless window where only the platypus, his bubble and the list take
 * clicks, and the rest passes through to whatever is underneath. In a plain
 * browser it works too, without those.
 */

/** What the pet's window (pet/preload.cjs) lets this page do. */
type Bridge = VoiceBridge & {
  /** Whether the pointer is over something to click; elsewhere clicks pass through. */
  solid: (on: boolean) => void;
  /** Where the window's top-left corner goes, in screen points. */
  moveTo: (x: number, y: number) => void;
  /** A drag of him starts (with where his body's middle is in the window) and ends; dropped on the circle it shows, he hides. */
  dragStart: (bodyX: number, bodyY: number) => void;
  dragEnd: () => void;
  onArmed: (listener: (armed: boolean) => void) => () => void;
  /** Seconds since the last key or mouse input anywhere on this computer. */
  idleSeconds: () => Promise<number>;
  /** A page of the dashboard (a path), opened unlocked in the browser. */
  openDashboard: (path?: string) => void;
  /** Showing him the screen (pet/look.js): a picture now; one taken with the Look hotkey; which keys that is on. Absent in a pet window from before. */
  look?: () => Promise<TakenShot>;
  onLook?: (listener: (shot: TakenShot) => void) => () => void;
  setLookHotkey?: (accelerator: string) => Promise<HotkeyState>;
};

declare global {
  interface Window { perryPet?: Bridge }
}

/** Nothing going on for this long (nothing to say, his panel shut, no work, no listening), and he takes his hat off and naps. */
const NAP_AFTER_MS = 30_000;
/** Heads-ups before a to-do is due, once each; the last five minutes are a countdown held on screen. */
const HEADS_UP_MIN = [15, 10];
const HOLD_MIN = 5;
const HEADS_UP_SHOWS_MS = 12_000;
/** A new version of him is mentioned once, for this long, when he has nothing else to say. */
const UPDATE_SHOWS_MS = 20_000;
/** The newest change he last mentioned, so each new version is mentioned once. */
const UPDATE_STORAGE = "perry.pet.update";
/** How long a dashboard tab already open has to take a page he opens, before he opens a new tab. */
const TAB_CLAIMS_MS = 1_500;

export function PetScreen() {
  const [key, setKey] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // The window's page is see-through; only what he draws shows.
    for (const element of [document.documentElement, document.body]) element.style.background = "transparent";
    document.documentElement.style.colorScheme = "normal";
    // The pet's window opens with the key in the fragment, as `perry open` does; it is kept and taken out of the address.
    const fromLink = new URLSearchParams(window.location.hash.slice(1)).get("key");
    if (fromLink) {
      window.localStorage.setItem(KEY_STORAGE, fromLink);
      window.history.replaceState(window.history.state, "", window.location.pathname);
    }
    setKey(window.localStorage.getItem(KEY_STORAGE));
    setReady(true);
  }, []);
  // A picture of the screen is sent as a file, which the media server takes with the key in its cookie, as the dashboard sets it.
  useEffect(() => {
    if (key) document.cookie = `perry_media=${encodeURIComponent(key)}; Path=/api/media; SameSite=Strict; Max-Age=31536000`;
  }, [key]);

  const session = useMemo(() => key ? { dashboardKey: key, lock: () => { window.localStorage.removeItem(KEY_STORAGE); setKey(null); } } : null, [key]);
  useClickThrough();

  if (!ready) return null;
  if (!session) {
    return (
      <Stage bubble={<Bubble title="I'm locked out." detail="Start me with perry pet, and I'll have the key." />}>
        <Body mood="idle" asleep={false} onClick={() => {}} />
      </Stage>
    );
  }
  return (
    <SessionContext.Provider value={session}>
      <Pet />
    </SessionContext.Provider>
  );
}

/**
 * Only what is marked data-solid takes the pointer. The window hears the
 * pointer everywhere (forwarded while it lets clicks through), so it can
 * tell the shell each time it crosses onto or off something to click.
 */
function useClickThrough() {
  useEffect(() => {
    const bridge = window.perryPet;
    if (!bridge) return;
    let solid = false;
    const move = (event: MouseEvent) => {
      const over = Boolean((event.target as Element | null)?.closest?.("[data-solid]"));
      if (over !== solid) bridge.solid((solid = over));
    };
    const leave = () => { if (solid) bridge.solid((solid = false)); };
    window.addEventListener("mousemove", move);
    document.addEventListener("mouseleave", leave);
    return () => {
      window.removeEventListener("mousemove", move);
      document.removeEventListener("mouseleave", leave);
    };
  }, []);
}

type Tab = "chat" | "todos" | "needs";
type Said = { title: string; detail?: string; until: number; onOpen?: () => void };
/** The chat the pet last had open, so he picks up where you left off. */
const CHAT_STORAGE = "perry.pet.chat";
const ASKS = { command: "run a command", file: "change files", write: "write a file", browser: "do this in its browser", contact: "talk with someone new", message: "message someone" } as const;
/** A step that has taken this long shows its time. */
const STEP_TIMER_MS = 5_000;
/** A step that finished between two reports is held up this long. */
const STEP_HOLD_MS = 2_500;

function Pet() {
  const key = useDashboardKey();
  const board = useQuery(api.todos.board, { key });
  const approvals = useQuery(api.approvals.pending, { key });
  const inbox = useQuery(api.dashboard.getInbox, { key });
  const chats = useQuery(api.dashboard.listChats, { key });
  const setDone = useMutation(api.todos.setDone);
  const pushBack = useMutation(api.todos.pushBack);
  const presence = useMutation(api.todos.presence);
  const decide = useMutation(api.approvals.decide);
  const setTimezone = useMutation(api.jobs.setTimezone);
  const { view: updates, update } = useUpdates();
  const now = useNow(1000);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("chat");
  const [chatId, setChatIdState] = useState<PetChatId>(null);
  const [draft, setDraft] = useState("");
  const petChat = useQuery(api.dashboard.getChat, chatId ? { key, id: chatId } : "skip");
  // What he is doing, step by step: in his chat, and anywhere else (a job, a message on the phone).
  const activity = useQuery(api.dashboard.getActivity, chatId ? { key, id: chatId } : "skip");
  const elsewhere = useQuery(api.dashboard.getActivity, { key });
  // The newest of his chat's messages, for a reply to hold up when it comes.
  const { results: newest } = usePaginatedQuery(api.dashboard.getChatMessages, chatId ? { key, id: chatId } : "skip", { initialNumItems: 2 });
  const [said, setSaid] = useState<Said | null>(null);
  const [reply, setReply] = useState<{ id: Id<"conversations">; since: number; streamed: string } | null>(null);
  const [cheer, setCheer] = useState(0);
  const lastBusy = useRef(Date.now());
  const cheerSeen = useRef(0);
  // Touched (a click, a drag), he wakes, and stays up a while after.
  const [, setTouched] = useState(0);
  const wake = useCallback(() => {
    lastBusy.current = Date.now();
    setTouched((count) => count + 1);
  }, []);
  const headsUp = useRef(new Map<string, number>());
  const notified = useRef(new Set<string>());
  const known = useRef<Set<string> | null>(null);
  const unseen = useRef<Set<string> | null>(null);
  const news = useRef<{ ids: string[]; until: number } | null>(null);
  const writing = useRef<{ since: number; text: string } | null>(null);
  const voice = useVoice(typeof window === "undefined" ? undefined : window.perryPet);
  // The Talk and Look hotkeys: the keys Settings has, taken up by his window, which says if another app has them.
  const shortcuts = useQuery(api.dashboard.getShortcuts, { key })?.shortcuts;
  const talkKeys = shortcuts?.talk;
  const lookKeys = shortcuts?.look;
  const [hotkey, setHotkey] = useState<HotkeyState>({ hotkey: null, error: null });
  const hotkeyNow = useRef(hotkey);
  hotkeyNow.current = hotkey;
  const [lookKey, setLookKey] = useState<HotkeyState>({ hotkey: null, error: null });
  const lookKeyNow = useRef(lookKey);
  lookKeyNow.current = lookKey;
  /** A picture of the screen waiting in his chat's box, to check before it goes with the question. */
  const [shot, setShot] = useState<Shot | null>(null);
  const idleNow = useRef(0);
  const [sendSignal, setSendSignal] = useState(0);
  /** Whether what is being said goes as soon as it is written down (the hotkey), or into the box to edit (the mic button). */
  const talkSends = useRef(false);
  const busy = useRef(false);
  busy.current = voice.state !== "idle";

  const say = useCallback((title: string, detail?: string, ms = 3500, onOpen?: () => void) => setSaid({ title, detail, until: Date.now() + ms, onOpen }), []);
  const setChatId = useCallback((id: PetChatId) => {
    setChatIdState(id);
    if (id) window.localStorage.setItem(CHAT_STORAGE, id);
    else window.localStorage.removeItem(CHAT_STORAGE);
  }, []);
  useEffect(() => { setChatIdState(window.localStorage.getItem(CHAT_STORAGE) as PetChatId); }, []);
  const askToOpen = useMutation(api.pet.askToOpen);
  const claimOpen = useMutation(api.pet.claimOpen);
  /**
   * A page of the dashboard, in the browser, unlocked: in a dashboard tab
   * already open, which takes it (components/dashboard/shell.tsx), or, when
   * none does in a moment, a new one. He claims it himself to open it, so it
   * is one or the other, never both.
   */
  const openPath = useCallback((path: string) => {
    const openNew = () => {
      if (window.perryPet) window.perryPet.openDashboard(path);
      else window.open(path, "_blank");
    };
    void (async () => {
      const request = await askToOpen({ key, path });
      await new Promise((resolve) => window.setTimeout(resolve, TAB_CLAIMS_MS));
      if (await claimOpen({ key, request })) openNew();
    })().catch(openNew);
  }, [key, askToOpen, claimOpen]);
  /** A chat in his panel, maybe with something already typed. */
  const openChat = useCallback((id: PetChatId, text?: string) => {
    setChatId(id);
    if (text !== undefined) setDraft(text);
    // A reply from another chat stays held up until that chat is read.
    setReply((held) => held && held.id === id ? null : held);
    setTab("chat");
    setOpen(true);
  }, [setChatId]);
  const reading = open && tab === "chat";

  // A new version of him: said once, for a little while, with the click that updates.
  const [updateNews, setUpdateNews] = useState<number | null>(null);
  useEffect(() => {
    const sha = updates && updateReady(updates) ? updates.latest?.sha : undefined;
    if (!sha || window.localStorage.getItem(UPDATE_STORAGE) === sha) return;
    window.localStorage.setItem(UPDATE_STORAGE, sha);
    setUpdateNews(Date.now() + UPDATE_SHOWS_MS);
  }, [updates]);
  const updateNow = useCallback(() => {
    setUpdateNews(null);
    void update().then((text) => say("See you in a few minutes", text, 6000), (cause) => say("I couldn't update", errorText(cause), 6000));
  }, [update, say]);

  // Scheduled things run in the owner's timezone, which only this computer knows.
  useEffect(() => {
    void setTimezone({ key, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }).catch(() => {});
  }, [key, setTimezone]);

  // How long the owner has been away, once a minute, for the server, which then sends reminders to the phone.
  useEffect(() => {
    const bridge = window.perryPet;
    if (!bridge) return;
    let lastReport = 0;
    const check = async () => {
      const seconds = await bridge.idleSeconds().catch(() => 0);
      idleNow.current = seconds;
      if (Date.now() - lastReport >= 60_000) {
        lastReport = Date.now();
        // Holding the Talk keys can start working meanwhile: on a Mac, once he is given Accessibility.
        const talk = await bridge.hotkey().catch(() => null);
        if (talk && (talk.hold ?? null) !== (hotkeyNow.current.hold ?? null)) {
          hotkeyNow.current = { ...hotkeyNow.current, hold: talk.hold };
          setHotkey(hotkeyNow.current);
        }
        void presence({ key, idleSeconds: seconds, ...reported(hotkeyNow.current, lookKeyNow.current) }).catch(() => {});
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 5_000);
    return () => window.clearInterval(timer);
  }, [key, presence]);

  // Something Perry added from a chat is news: he says so.
  useEffect(() => {
    if (!board) return;
    const ids = new Set(board.open.map((todo) => todo.id as string));
    if (known.current) {
      const added = board.open.filter((todo) => !known.current!.has(todo.id) && todo.by === "assistant");
      if (added.length) say(added.length === 1 ? `Perry added “${added[0].title}”` : `Perry added ${added.length} to-dos`, added[0].dueAt ? dueLabel(added[0].dueAt) : undefined, 5000, () => { setTab("todos"); setOpen(true); });
    }
    known.current = ids;
  }, [board, say]);

  // Other chats with something new in them (a schedule's result, a reply you left for): he says where.
  // Several at once, or one while he is still saying another, are said together, so none is lost.
  // His own chat's reply has its own bubble, below.
  useEffect(() => {
    if (!chats) return;
    const current = new Set(chats.filter((chat) => chat.unseen).map((chat) => chat.id as string));
    if (unseen.current) {
      const fresh = chats.filter((chat) => chat.unseen && !unseen.current!.has(chat.id) && chat.id !== chatId);
      if (fresh.length) {
        const saying = news.current && news.current.until > Date.now() ? news.current.ids : [];
        const ids = [...fresh.map((chat) => chat.id as string), ...saying.filter((id) => current.has(id) && !fresh.some((chat) => chat.id === id))];
        const titles = ids.map((id) => chats.find((chat) => chat.id === id)?.title ?? "a chat");
        const first = fresh[0].id;
        news.current = { ids, until: Date.now() + 8000 };
        say(ids.length === 1 ? `New in ${titles[0]}` : `New in ${ids.length} chats`, ids.length > 1 ? titles.join(", ") : undefined, 8000, () => openChat(first));
      }
    }
    unseen.current = current;
  }, [chats, say, openChat, chatId]);

  // His own chat's reply, finished while you were not reading it: he holds it up until you do.
  useEffect(() => {
    if (!petChat || !chatId) return;
    if (petChat.isRunning) {
      writing.current = { since: writing.current?.since ?? Date.now(), text: petChat.streaming ?? writing.current?.text ?? "" };
      return;
    }
    if (writing.current && !reading) setReply({ id: chatId, since: writing.current.since, streamed: writing.current.text });
    writing.current = null;
  }, [petChat, chatId, reading]);
  useEffect(() => { if (reading) setReply((held) => held && held.id === chatId ? null : held); }, [reading, chatId]);
  // The saved reply, kept with it: opening another chat first leaves it still held up, and still worded.
  useEffect(() => {
    if (!reply || reply.id !== chatId) return;
    const saved = newest.find((message) => message.role === "assistant" && message.createdAt >= reply.since)?.text;
    if (saved && saved !== reply.streamed) setReply({ ...reply, streamed: saved });
  }, [reply, chatId, newest]);

  // At its time, a notification from the system as well, once, in case he is behind a full-screen window.
  useEffect(() => {
    if (!board || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    for (const todo of board.open) {
      if (todo.dueAt === undefined || todo.dueAt > now || now - todo.dueAt > 10 * 60_000) continue;
      const mark = `${todo.id}:${todo.dueAt}`;
      if (notified.current.has(mark)) continue;
      notified.current.add(mark);
      new Notification(todo.title, { body: `Due ${dueLabel(todo.dueAt, now)}`, tag: mark, silent: false });
    }
  }, [board, now]);

  // Talking: the mic button, or the hotkey from anywhere, which opens his chat already listening.
  // His window keeps whether the hotkey has him listening; when the page stops on its own (its buttons, Esc in
  // the page, a microphone that would not open), it says so at once (voiceDone), so the next press starts again.
  // Not when the hotkey stopped him: by the time what was said is written down, a press may have started him again.
  const { start: listen, stop: stopListening, cancel: cancelListening } = voice;
  const talk = useCallback((sends: boolean) => {
    talkSends.current = sends;
    setTab("chat");
    setOpen(true);
    void listen().then((on) => { if (!on && sends) window.perryPet?.voiceDone(); });
  }, [listen]);
  const heard = useCallback(async (byKeys = false) => {
    const sends = talkSends.current;
    if (!byKeys) window.perryPet?.voiceDone();
    const text = await stopListening();
    if (!text) return;
    setDraft((previous) => (previous.trim() ? `${previous.trimEnd()} ${text}` : text));
    if (sends) setSendSignal((count) => count + 1);
  }, [stopListening]);
  const stopTalking = useCallback((byKeys = false) => {
    cancelListening();
    if (!byKeys) window.perryPet?.voiceDone();
  }, [cancelListening]);
  const listeningNow = useRef(false);
  listeningNow.current = voice.state === "listening";
  useEffect(() => {
    const bridge = window.perryPet;
    if (!bridge) return;
    return bridge.onVoice((type) => {
      // Listening from the mic button, which his window knew nothing of: the hotkey is pressed to finish.
      if (type === "start" && listeningNow.current) void heard();
      else if (type === "start") talk(true);
      else if (type === "stop") void heard(true);
      else stopTalking(true);
    });
  }, [talk, heard, stopTalking]);
  // New keys in Settings: he moves to them, and says at once how that went, for Settings to show.
  useEffect(() => {
    const bridge = window.perryPet;
    if (!bridge || !talkKeys) return;
    void bridge.setHotkey(talkKeys).then((result) => {
      // At once, not at the next render: the Look keys' report carries these too.
      hotkeyNow.current = result;
      setHotkey(result);
      void presence({ key, idleSeconds: idleNow.current, ...reported(result, lookKeyNow.current) }).catch(() => {});
    }, () => {});
  }, [talkKeys, key, presence]);
  // The same for the Look keys. A pet window from before Look has none, and says it needs a restart.
  useEffect(() => {
    const bridge = window.perryPet;
    if (!bridge || !lookKeys) return;
    const taking = bridge.setLookHotkey ? bridge.setLookHotkey(lookKeys) : Promise.resolve({ hotkey: null, error: "restart" });
    void taking.then((result) => {
      lookKeyNow.current = result;
      setLookKey(result);
      void presence({ key, idleSeconds: idleNow.current, ...reported(hotkeyNow.current, result) }).catch(() => {});
    }, () => {});
  }, [lookKeys, key, presence]);

  // A picture of the screen: his chat opens with it in the box, ready for the question.
  const showShot = useCallback((taken: TakenShot) => {
    if (!taken.window && !taken.screen) return say("I couldn't see the screen", taken.error, 8000);
    setShot({ ...taken, use: taken.window ? "window" : "screen" });
    setTab("chat");
    setOpen(true);
  }, [say]);
  useEffect(() => window.perryPet?.onLook?.(showShot), [showShot]);

  // Perry asking to see the screen in a chat (convex/screen.ts): the picture is taken here, kept, and handed back.
  const lookRequests = useQuery(api.screen.asked, window.perryPet ? { key } : "skip");
  const fulfilLook = useMutation(api.screen.fulfil);
  const looking = useRef(new Set<string>());
  useEffect(() => {
    for (const request of lookRequests ?? []) {
      if (looking.current.has(request.id)) continue;
      looking.current.add(request.id);
      void (async () => {
        try {
          if (!window.perryPet?.look) throw new Error("This desktop pet is from before Perry could look at the screen; ask the owner to restart it (Quit from its tray icon, then turn it on again).");
          const taken = await window.perryPet.look();
          const picture = taken[request.which] ?? taken.screen ?? taken.window;
          if (!picture) throw new Error(taken.error ?? "The desktop pet could not take the picture.");
          const kept = await keepPicture(picture.image);
          await fulfilLook({ key, id: request.id, path: kept.path, name: picture.name });
          say("I looked at your screen", request.why, 6000);
        } catch (error) {
          await fulfilLook({ key, id: request.id, error: error instanceof Error ? error.message : String(error) }).catch(() => {});
        }
      })();
    }
  }, [lookRequests, key, fulfilLook, say]);
  const lookNow = useCallback(async () => {
    const taken = await window.perryPet?.look?.().catch((error: unknown) => ({ error: String(error) }));
    if (taken) showShot(taken);
  }, [showShot]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (busy.current) stopTalking();
      else setOpen(false);
    };
    // Clicking anywhere else closes the panel, as a menu does; what you were writing stays. Not while he listens.
    const onBlur = () => { if (!busy.current) setOpen(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("blur", onBlur); };
  }, [stopTalking]);

  const done = (todo: TodoView) => {
    void setDone({ key, id: todo.id, done: true }).catch(() => {});
    setCheer((count) => count + 1);
    const streak = (board?.streak ?? 0) || 1;
    say("Done!", streak > 1 ? `${plural(streak, "day")} in a row` : undefined, 2500);
  };

  // What he has to say, most pressing first: a computer waiting on you, something late, the last minutes
  // before something, a reply you have not read, what he is working on, a heads-up.
  const asking = (approvals ?? []).filter((item) => item.expiresAt > now);
  const needs = asking.length + (inbox?.length ?? 0);
  const timed = (board?.open ?? []).filter((todo) => todo.dueAt !== undefined);
  const late = timed.filter((todo) => todo.dueAt! <= now);
  const next = timed.find((todo) => todo.dueAt! > now);
  const working = Boolean(petChat?.isRunning) && !reading;
  // The step he is on; between steps, the one that just finished, held up a moment, so a quick one is seen at all.
  const stepOf = (of?: Activity | null) => !of?.running || !of.step ? undefined
    : of.step.live || !of.recent || now - of.recent.endedAt > STEP_HOLD_MS ? of.step : of.recent;
  const step = working ? stepOf(activity) : undefined;
  const away = !petChat?.isRunning && elsewhere?.running && elsewhere.conversationId !== chatId ? elsewhere : undefined;
  const awayStep = stepOf(away);
  // How long the step has taken, once that is worth saying.
  const took = (since?: number) => since !== undefined && now - since >= STEP_TIMER_MS ? countdown(now - since) : undefined;
  let bubble: ReactNode = null;
  let urgent = false;
  if (said && said.until > now) {
    const onOpen = said.onOpen;
    bubble = <Bubble title={said.title} detail={said.detail} onClose={() => setSaid(null)} onOpen={onOpen && (() => { setSaid(null); onOpen(); })} />;
  } else if (asking.length) {
    const ask = asking[asking.length - 1];
    urgent = true;
    bubble = (
      <Bubble tone="ask" title={`${ask.runner} wants to ${ASKS[ask.kind]}`} code={ask.title}
        detail={[ask.chat && `In ${ask.chat.title}`, asking.length > 1 && `${asking.length - 1} more waiting`].filter(Boolean).join(" · ") || undefined}>
        <BubbleButton primary onClick={() => void decide({ key, id: ask.id, approved: true })}>Approve</BubbleButton>
        <BubbleButton onClick={() => void decide({ key, id: ask.id, approved: false })}>Decline</BubbleButton>
        <BubbleButton onClick={() => { setTab("needs"); setOpen(true); }}>More</BubbleButton>
      </Bubble>
    );
  } else if (late.length) {
    const todo = late[late.length - 1];
    urgent = true;
    bubble = (
      <Bubble tone="late" title={todo.title} detail={`${countdown(now - todo.dueAt!)} late${late.length > 1 ? ` · ${late.length - 1} more` : ""}`}>
        <BubbleButton primary onClick={() => done(todo)}>Done</BubbleButton>
        <BubbleButton onClick={() => void pushBack({ key, id: todo.id, minutes: 10 })}>10 min</BubbleButton>
        <BubbleButton onClick={() => void pushBack({ key, id: todo.id, minutes: 60 })}>1 hour</BubbleButton>
      </Bubble>
    );
  } else if (next && next.dueAt! - now <= HOLD_MIN * 60_000) {
    urgent = true;
    bubble = (
      <Bubble tone="soon" title={next.title} detail={`in ${countdown(next.dueAt! - now)}`}>
        <BubbleButton primary onClick={() => done(next)}>Done</BubbleButton>
        <BubbleButton onClick={() => void pushBack({ key, id: next.id, minutes: 10 })}>Later</BubbleButton>
      </Bubble>
    );
  } else if (reply) {
    // The saved reply once it is in; until then, what was streamed of it.
    const saved = reply.id === chatId ? newest.find((message) => message.role === "assistant" && message.createdAt >= reply.since) : undefined;
    // Under the reply, what it took: "Ran 3 commands · read 2 pages".
    const did = reply.id === chatId && activity && !activity.running ? activity.summary : "";
    bubble = <Bubble title="Perry" detail={excerpt(saved?.text || reply.streamed || "…")} note={did || undefined} onOpen={() => openChat(reply.id)} onClose={() => setReply(null)} />;
  } else if (working) {
    const writing = step?.label === "Writing the reply" && petChat?.streaming;
    bubble = <Bubble id="working" title={step?.label ?? "On it…"} detail={writing ? excerpt(petChat!.streaming!, true) : took(step?.since)} onOpen={() => openChat(chatId)} />;
  } else if (away && awayStep) {
    const where = [away.chat && `In ${away.chat}`, took(awayStep.since)].filter(Boolean).join(" · ");
    bubble = <Bubble id="elsewhere" title={awayStep.label} detail={where || undefined} onOpen={() => openChat(away.conversationId)} />;
  } else if (next) {
    const minutes = (next.dueAt! - now) / 60_000;
    const step = [...HEADS_UP_MIN].reverse().find((mark) => minutes <= mark);
    if (step !== undefined) {
      const mark = `${next.id}:${next.dueAt}:${step}`;
      if (!headsUp.current.has(mark)) headsUp.current.set(mark, now);
      if (now - headsUp.current.get(mark)! < HEADS_UP_SHOWS_MS) {
        bubble = <Bubble title={`Psst: ${next.title}`} detail={`in ${Math.ceil(minutes)} min`} onClose={() => headsUp.current.set(mark, 0)} />;
      }
    }
  }
  if (!bubble && updateNews && updateNews > now && updates && updateReady(updates)) {
    bubble = (
      <Bubble id="update" title="A new version of me is ready" detail={`${plural(updates.behind, "change")} · ${updates.latest?.title ?? ""}`} onClose={() => setUpdateNews(null)}>
        <BubbleButton primary onClick={updateNow}>Update</BubbleButton>
        <BubbleButton onClick={() => setUpdateNews(null)}>Later</BubbleButton>
      </Bubble>
    );
  }

  // Off duty, as in the show: with nothing going on he naps, hat off; anything at all and the fedora goes back on.
  const onDuty = Boolean(bubble) || open || urgent || Boolean(petChat?.isRunning) || voice.state !== "idle" || cheer !== cheerSeen.current;
  if (onDuty) {
    lastBusy.current = now;
    cheerSeen.current = cheer;
  }
  const asleep = !onDuty && now - lastBusy.current >= NAP_AFTER_MS;
  // Under his name: what he is doing, what waits on you, or a new version of him, a click away.
  const status: ReactNode = petChat?.isRunning ? `${step?.label ?? "Working on it"}…`
    : needs ? `${plural(needs, "thing")} waiting on you`
      : updates?.state === "updating" ? "Updating myself; back in a few minutes"
        : updates?.state === "waiting" ? "Updating once I'm done"
          : updateReady(updates) ? (
            <>A new version is ready ·{" "}
              <button type="button" onClick={updateNow} className="cursor-pointer font-medium text-primary hover:underline">Update</button>
            </>
          ) : "Here when you need him";
  const panel = (
    <Panel tab={tab} onTab={setTab} needs={needs} onClose={() => setOpen(false)} onOpenApp={() => openPath("/")}
      status={status} busy={Boolean(petChat?.isRunning)}>
      {tab === "chat" ? (
        <PetChat chatId={chatId} onChatId={setChatId} draft={draft} onDraft={setDraft} open={openPath}
          voice={window.perryPet ? voice : undefined} hotkey={hotkey.hotkey} hold={hotkey.hold ?? null} byHotkey={talkSends.current} sendSignal={sendSignal}
          onTalk={() => talk(false)} onTalkSend={() => void heard()} onTalkCancel={() => stopTalking()}
          shot={shot} onShot={setShot} onLook={window.perryPet?.look ? () => void lookNow() : undefined} lookKeys={lookKey.hotkey} />
      )
        : tab === "needs" ? <PetNeedsYou now={now} onChat={openChat} open={openPath} />
          : <PetTodos board={board} now={now} onDone={done} onAdded={(title, dueAt) => say(`Got it: ${title}`, dueAt ? dueLabel(dueAt) : undefined, 2500)} />}
    </Panel>
  );
  return (
    <Stage bubble={open ? panel : bubble}>
      <Body mood={voice.state === "listening" ? "listening" : urgent ? "urgent" : petChat?.isRunning || voice.state === "transcribing" ? "thinking" : "idle"}
        level={voice.levels[voice.levels.length - 1]} asleep={asleep} cheer={cheer} badge={open ? 0 : needs} onTouch={wake}
        pose={voice.state === "idle" ? (step ?? awayStep)?.pose : undefined}
        onClick={() => setOpen((value) => !value)} />
    </Stage>
  );
}

/** The hotkeys' standing, as presence reports it: the keys held, why not the ones asked for, and why the Talk keys can only be tapped. */
const standing = (state: HotkeyState) => ({ ...(state.hotkey ? { hotkey: state.hotkey } : {}), ...(state.error ? { error: state.error } : {}) });
const reported = (talk: HotkeyState, look: HotkeyState) => {
  const { hotkey, error } = standing(talk);
  return { ...(hotkey ? { hotkey } : {}), ...(error ? { hotkeyError: error } : {}), ...(talk.hold ? { hotkeyHold: talk.hold } : {}), keys: { look: standing(look) } };
};

/** A line or two of a reply, for a bubble: its start, or while it is being written, its end. */
function excerpt(text: string, end = false): string {
  const plain = text.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
  if (plain.length <= 140) return plain;
  return end ? `…${plain.slice(-140)}` : `${plain.slice(0, 140)}…`;
}

/** The window's contents: the panel or a bubble above, and him in the bottom corner. */
function Stage({ bubble, children }: { bubble: ReactNode; children: ReactNode }) {
  return (
    <main className="fixed inset-0 flex select-none flex-col items-end justify-end gap-1 overflow-hidden p-3 pr-4">
      <AnimatePresence mode="wait">{bubble}</AnimatePresence>
      {children}
    </main>
  );
}

type Tone = "late" | "soon" | "ask";

/** Something he says. With onOpen, a click on it opens what it is about. */
function Bubble({ id, title, detail, note, code, tone, onClose, onOpen, children }: {
  /** Keeps it the same bubble while its words change, as a step does. */
  id?: string;
  title: string; detail?: string;
  /** A quiet last line, like what a reply took. */
  note?: string;
  code?: string; tone?: Tone; onClose?: () => void; onOpen?: () => void; children?: ReactNode;
}) {
  return (
    <motion.div
      key={id ?? `${title}:${tone ?? ""}`}
      data-solid
      role="status"
      initial={{ opacity: 0, y: 10, scale: 0.92 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 420, damping: 28 }}
      style={{ transformOrigin: "85% 100%" }}
      onClick={onOpen}
      className={cn(
        "group/bubble relative mr-6 w-max min-w-[176px] max-w-[300px] rounded-2xl border bg-popover px-3.5 py-3 text-popover-foreground shadow-[0_12px_32px_-8px_rgb(0_0_0/0.35)]",
        tone === "late" && "border-destructive/45",
        tone === "ask" && "border-warning/55",
        onOpen && "cursor-pointer",
      )}
    >
      <span aria-hidden className={cn("absolute right-10 -bottom-[7px] size-3.5 rotate-45 rounded-br-[3px] border-r border-b bg-popover",
        tone === "late" && "border-destructive/45", tone === "ask" && "border-warning/55")} />
      {onClose && (
        <button type="button" aria-label="Hide" onClick={(event) => { event.stopPropagation(); onClose(); }}
          className="absolute top-1.5 right-1.5 grid size-5 cursor-pointer place-items-center rounded-full text-muted-foreground hover:bg-muted">
          <XIcon className="size-3" aria-hidden />
        </button>
      )}
      <p className={cn("text-[14px] font-semibold leading-snug tracking-[-0.005em]", onClose && "pr-5", onOpen && "group-hover/bubble:text-primary")}>{title}</p>
      {code && <pre className="mt-1.5 max-h-16 overflow-hidden rounded-md bg-muted px-2 py-1 font-mono text-[11.5px] whitespace-pre-wrap [overflow-wrap:anywhere]">{code.slice(0, 160)}</pre>}
      {detail && <p className={cn("mt-0.5 text-[12.5px] text-pretty nums", tone === "late" ? "font-medium text-destructive" : tone === "soon" ? "font-medium text-warning" : "text-muted-foreground")}>{detail}</p>}
      {note && <p className="mt-1.5 text-[11.5px] text-muted-foreground/80">{note}</p>}
      {children && <div className="mt-2.5 flex gap-1.5">{children}</div>}
    </motion.div>
  );
}

function BubbleButton({ primary, onClick, children }: { primary?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      className={cn(
        "h-7 cursor-pointer rounded-lg px-3 text-[12.5px] font-medium transition-colors",
        primary ? "bg-primary text-primary-foreground hover:bg-primary/90" : "border bg-background text-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

/**
 * The platypus. Eyes on the pointer, a blink now and then, a bob; he fidgets
 * when something needs you, looks up while he works on something, jumps and
 * tips his hat when a thing is done. With nothing going on he is off duty, as
 * in the show: hat off, eyes shut, dozing; needed, the fedora drops back on. A
 * number on him is what is waiting in Needs you. A click opens his panel; a
 * drag moves him, and dropped on the circle that shows at the bottom middle
 * of the screen while he is dragged, he hides.
 */
function Body({ mood, pose, level = 0, asleep, cheer = 0, badge = 0, onClick, onTouch }: {
  mood: "idle" | "urgent" | "thinking" | "listening";
  /** What he is doing, shown by the prop beside him. */
  pose?: Pose;
  level?: number;
  /** Off duty: hat off, napping. */
  asleep: boolean;
  cheer?: number; badge?: number; onClick: () => void;
  /** Pressed on: he wakes. */
  onTouch?: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const reduced = useReducedMotion();
  const controls = useAnimationControls();
  const [look, setLook] = useState({ x: 0, y: 0 });
  const [blink, setBlink] = useState(false);
  const [tip, setTip] = useState(false);
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  // Held over the circle that hides him, he looks down at it, worried.
  const [armed, setArmed] = useState(false);
  useEffect(() => window.perryPet?.onArmed(setArmed), []);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const box = ref.current?.getBoundingClientRect();
      if (!box) return;
      const dx = event.clientX - (box.left + box.width / 2);
      const dy = event.clientY - (box.top + box.height * 0.45);
      const d = Math.max(1, Math.hypot(dx, dy));
      const reach = Math.min(1, d / 200);
      setLook({ x: (dx / d) * reach, y: (dy / d) * reach });
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, []);

  useEffect(() => {
    if (asleep) return;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      timer = setTimeout(() => {
        setBlink(true);
        setTimeout(() => setBlink(false), 140);
        next();
      }, 2600 + Math.random() * 3200);
    };
    next();
    return () => clearTimeout(timer);
  }, [asleep]);

  // Woken: the fedora drops back on, and he hops as it lands, a little squashed, then up. His own
  // moves (this, the cheer, the hat) play even where the system asks for less motion; only the endless bob stops.
  const wasAsleep = useRef(asleep);
  useEffect(() => {
    const woke = wasAsleep.current && !asleep;
    wasAsleep.current = asleep;
    if (!woke) return;
    void controls.start({
      y: [0, 0, -14, 0, -3, 0],
      scaleY: [1, 0.9, 1.08, 0.95, 1.02, 1],
      scaleX: [1, 1.08, 0.94, 1.04, 0.99, 1],
      transition: { duration: 0.75, times: [0, 0.3, 0.5, 0.7, 0.85, 1], ease: "easeOut" },
    });
  }, [asleep, controls]);

  // Done: a hop and a hat tip.
  useEffect(() => {
    if (!cheer) return;
    setTip(true);
    const timer = setTimeout(() => setTip(false), 700);
    void controls.start({ y: [0, -26, 0, -8, 0], transition: { duration: 0.7, ease: "easeOut" } });
    return () => clearTimeout(timer);
  }, [cheer, controls]);

  const down = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    onTouch?.();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.screenX, y: event.screenY, left: window.screenX, top: window.screenY, moved: false };
    // Letting go ends the drag wherever the pointer is, even if something took the capture from him on the way.
    const release = () => { window.removeEventListener("pointerup", release, true); if (drag.current) up(); };
    window.addEventListener("pointerup", release, true);
  };
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = drag.current;
    if (!start) return;
    const dx = event.screenX - start.x;
    const dy = event.screenY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < 4) return;
    if (!start.moved) {
      const box = ref.current?.getBoundingClientRect();
      if (box) window.perryPet?.dragStart(Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2));
    }
    start.moved = true;
    window.perryPet?.moveTo(Math.round(start.left + dx), Math.round(start.top + dy));
  };
  const up = () => {
    const start = drag.current;
    drag.current = null;
    if (start?.moved) window.perryPet?.dragEnd();
    else if (start) onClick();
  };

  // Asleep, he breathes, even with less motion asked for; awake, the bob and fidgets stop then.
  const bob = asleep ? { y: [0, 2, 0], scaleY: [1, 0.97, 1], transition: { duration: 4.5, repeat: Infinity, ease: "easeInOut" as const } }
    : reduced ? undefined
      : mood === "urgent" ? { rotate: [0, -5, 5, -3, 0, 0, 0], y: [0, -4, 0, 0, 0, 0, 0], transition: { duration: 2.4, repeat: Infinity } }
        : mood === "thinking" ? { rotate: [0, 3, 0, -3, 0], transition: { duration: 2.8, repeat: Infinity, ease: "easeInOut" as const } }
          : mood === "listening" ? { y: -2, scale: 1 + level * 0.06, transition: { duration: 0.08 } }
          : { y: [0, -3, 0], transition: { duration: 3.2, repeat: Infinity, ease: "easeInOut" as const } };

  return (
    <motion.div animate={controls} className="relative shrink-0" style={{ transformOrigin: "50% 100%" }}>
      {/* Over the circle that hides him, he shrinks into it, so it and what it says stay in sight. */}
      <motion.div animate={{ scale: armed ? 0.5 : 1 }} transition={{ type: "spring", stiffness: 420, damping: 26 }}>
      <motion.button
        ref={ref}
        type="button"
        data-solid
        data-state={asleep ? "asleep" : "awake"}
        aria-label={`Perry. Click to open him${badge ? `; ${badge} waiting on you` : ""}; drag to move him.`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => { if (drag.current?.moved) window.perryPet?.dragEnd(); drag.current = null; }}
        className="block w-[104px] cursor-pointer touch-none rounded-3xl outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
        animate={bob}
        style={{ transformOrigin: "50% 100%" }}
      >
        <PlatypusArt
          look={armed ? { x: 0, y: 1 } : mood === "thinking" ? { x: 0.5, y: -0.9 } : mood === "listening" ? { x: -0.2, y: 0.1 } : look}
          lid={blink ? 1 : armed || mood === "urgent" || mood === "listening" ? 0.05 : 0.32}
          hatLift={tip ? 16 : mood === "listening" ? 6 + level * 12 : 0}
          asleep={asleep}
          hat={!asleep}
          className="pointer-events-none h-auto w-full drop-shadow-[0_8px_10px_rgb(0_0_0/0.22)]"
        />
      </motion.button>
      </motion.div>
      <AnimatePresence>
        {pose && !asleep && <Prop key={pose} pose={pose} reduced={Boolean(reduced)} />}
      </AnimatePresence>
      {badge > 0 && (
        <span className="pointer-events-none absolute top-1 right-0 grid h-5 min-w-5 place-items-center rounded-full bg-warning px-1.5 text-[11px] font-bold text-background shadow" aria-hidden>
          {badge}
        </span>
      )}
    </motion.div>
  );
}

/** The prop for each kind of step, so what he is doing reads at a glance without the bubble. */
const PROPS: Record<Pose, { icon: LucideIcon; label: string; move: "tilt" | "scan" | "pulse" | "scribble" }> = {
  thinking: { icon: BrainIcon, label: "Thinking", move: "pulse" },
  reading: { icon: BookOpenIcon, label: "Reading", move: "tilt" },
  typing: { icon: PencilIcon, label: "Writing", move: "scribble" },
  searching: { icon: SearchIcon, label: "Searching", move: "scan" },
  running: { icon: TerminalIcon, label: "Working on the computer", move: "pulse" },
  drawing: { icon: PaletteIcon, label: "Drawing", move: "scribble" },
  remembering: { icon: NotebookPenIcon, label: "Checking his notes", move: "tilt" },
  waiting: { icon: HourglassIcon, label: "Waiting for you", move: "tilt" },
};

/** Beside him, low on his left: a small round chip with the prop, moving the way the step does. */
function Prop({ pose, reduced }: { pose: Pose; reduced: boolean }) {
  const { icon: Icon, label, move } = PROPS[pose];
  const loop = reduced ? undefined
    : move === "scan" ? { x: [0, 5, -3, 0], transition: { duration: 1.6, repeat: Infinity, ease: "easeInOut" as const } }
      : move === "scribble" ? { rotate: [0, -12, 8, -6, 0], transition: { duration: 0.9, repeat: Infinity } }
        : move === "tilt" ? { rotate: [0, 6, 0, -6, 0], transition: { duration: 2.4, repeat: Infinity, ease: "easeInOut" as const } }
          : { scale: [1, 1.12, 1], transition: { duration: 1.4, repeat: Infinity, ease: "easeInOut" as const } };
  return (
    <motion.span
      role="img" aria-label={label} title={label} data-pose={pose}
      initial={{ opacity: 0, scale: 0.4, y: 6 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.4 }}
      transition={{ type: "spring", stiffness: 500, damping: 26 }}
      className="pointer-events-none absolute bottom-6 -left-1 grid size-8 place-items-center rounded-full border bg-popover text-primary shadow-md"
    >
      <motion.span animate={loop} className="grid place-items-center"><Icon className="size-4" aria-hidden /></motion.span>
    </motion.span>
  );
}

/** His panel: a small Perry, with your chats, your to-dos, and what is waiting on you. */
function Panel({ tab, onTab, needs, status, busy, onClose, onOpenApp, children }: {
  tab: Tab; onTab: (tab: Tab) => void; needs: number;
  /** What he is up to, under his name. */
  status: ReactNode; busy: boolean;
  onClose: () => void; onOpenApp: () => void; children: ReactNode;
}) {
  const tabs: Array<[Tab, string, typeof MessageCircleIcon]> = [["chat", "Chat", MessageCircleIcon], ["todos", "To-dos", ListTodoIcon], ["needs", "Needs you", InboxIcon]];
  return (
    <motion.section
      key="panel"
      data-solid
      aria-label="Perry"
      initial={{ opacity: 0, y: 12, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.97 }}
      transition={{ type: "spring", stiffness: 420, damping: 30 }}
      style={{ transformOrigin: "85% 100%" }}
      className="flex h-[480px] w-[372px] flex-col overflow-hidden rounded-[20px] border bg-background text-foreground shadow-[0_24px_56px_-12px_rgb(0_0_0/0.4)]"
    >
      <header className="flex items-center gap-2.5 px-3.5 pt-3 pb-2.5">
        <span className="relative shrink-0">
          <PlatypusArt head className="size-9 rounded-full bg-brand-soft" />
          <span className={cn("absolute right-0 bottom-0 size-2.5 rounded-full border-2 border-background", busy ? "animate-pulse bg-primary" : "bg-success")} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14.5px] leading-tight font-semibold tracking-[-0.01em]">Perry</p>
          <p className="truncate text-[12px] leading-tight text-muted-foreground" aria-live="polite">{status}</p>
        </div>
        <button type="button" onClick={onOpenApp} aria-label="Open Perry" title="Open Perry"
          className="grid size-8 cursor-pointer place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
          <ExternalLinkIcon className="size-4" aria-hidden />
        </button>
        <button type="button" onClick={onClose} aria-label="Close" title="Close"
          className="grid size-8 cursor-pointer place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
          <XIcon className="size-4" aria-hidden />
        </button>
      </header>
      <div role="tablist" aria-label="Perry" className="mx-3 mb-2.5 grid grid-cols-3 gap-0.5 rounded-xl bg-muted p-[3px]">
        {tabs.map(([value, label, Icon]) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => onTab(value)}
            className={cn("flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-[9px] text-[12.5px] font-medium transition-colors",
              tab === value ? "bg-background text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_1px_var(--border)]" : "text-muted-foreground hover:text-foreground")}>
            <Icon className="size-3.5" aria-hidden />
            {label}
            {value === "needs" && needs > 0 && <span className="grid h-4 min-w-4 place-items-center rounded-full bg-warning px-1 text-[10.5px] font-bold text-background nums">{needs}</span>}
          </button>
        ))}
      </div>
      {children}
    </motion.section>
  );
}

function PetTodos({ board, now, onDone, onAdded }: {
  board: Board | undefined;
  now: number;
  onDone: (todo: TodoView) => void;
  onAdded: (title: string, dueAt?: number) => void;
}) {
  const key = useDashboardKey();
  const endDay = useMutation(api.todos.endDay);
  const [ending, setEnding] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const leftToday = (board?.open ?? []).filter((todo) => todo.dueAt !== undefined && todo.dueAt < midnight.getTime()).length;

  return (
    <>
      <QuickAdd autoFocus onAdded={onAdded} className="px-3" />
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1">
        {board === undefined ? <p className="px-2.5 py-3 text-[13px] text-muted-foreground">Loading…</p>
          : board.open.length === 0 ? (
            <Empty title={board.doneToday.length ? "All done for now" : "Nothing on your list"}>
              Type one above, like “stretch every day at 11”, or tell Perry in a chat.
            </Empty>
          ) : (<>
            <div className="flex items-center gap-2 px-2.5 pt-1 pb-0.5">
              <p className="flex-1 text-[11.5px] font-medium tracking-wide text-muted-foreground uppercase">
                {leftToday ? `${leftToday} left today` : `${board.open.length} to do`}
              </p>
              <StreakBadge days={board.streak} />
            </div>
            <TodoRows todos={board.open} now={now} compact onDone={onDone} />
          </>)}
        {board && board.doneToday.length > 0 && (
          <div className="px-1 pt-1.5">
            <button type="button" onClick={() => setShowDone((value) => !value)} aria-expanded={showDone}
              className="flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] font-medium text-muted-foreground hover:text-foreground">
              <CheckIcon className="size-3.5 text-success" aria-hidden />{board.doneToday.length} done today
            </button>
            {showDone && <TodoRows todos={board.doneToday} now={now} compact />}
          </div>
        )}
      </div>
      {leftToday > 0 && (
        <footer className="flex h-11 items-center gap-1.5 border-t bg-muted/30 px-3">
          {ending ? (
            <>
              <BubbleButton primary onClick={() => { void endDay({ key, action: "move" }); setEnding(false); }}>Move {leftToday} to tomorrow</BubbleButton>
              <BubbleButton onClick={() => { void endDay({ key, action: "clear" }); setEnding(false); }}>Clear</BubbleButton>
              <span className="flex-1" />
              <button type="button" onClick={() => setEnding(false)} className="cursor-pointer text-[12px] text-muted-foreground hover:text-foreground">Cancel</button>
            </>
          ) : (
            <button type="button" onClick={() => setEnding(true)}
              className="flex cursor-pointer items-center gap-1.5 rounded-md px-1 py-1 text-[12.5px] font-medium text-muted-foreground hover:text-foreground">
              <MoonIcon className="size-3.5" aria-hidden />End the day · {leftToday} left
            </button>
          )}
        </footer>
      )}
    </>
  );
}
