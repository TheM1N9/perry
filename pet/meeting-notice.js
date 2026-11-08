import { BrowserWindow, Menu, ipcMain, screen } from "electron";
import { join } from "node:path";

/** A detected call asks this long, then leaves the owner be; the pointer resting on it pauses the count. */
const CALL_ASKS_MS = 20_000;
/** "Your notes are ready" stays this long. */
const READY_MS = 12_000;
/** A recording this short ("Started by mistake?") is offered for throwing away this long, then kept. */
const MISTAKE_MS = 15_000;
const MISTAKE_WORDS = 20;
/** After the pointer leaves, a paused card has at least this long left. */
const AFTER_HOVER_MS = 3_000;
const SNOOZE_MS = 2 * 60_000;
/** A discarded recording really goes only after this long, so Discard can be undone. */
const UNDO_DISCARD_MS = 6_000;
/** The card's window has this much see-through margin round what shows. */
const WINDOW_MARGIN = 12;

/**
 * One small native window survives pet page reloads; all calendar data is replaced on each heartbeat.
 * It shows one card at a time: a recording's controls, "Started by mistake?", "Your notes are ready", or a prompt.
 */
export function meetingNotice({ here, start, stop, keepGoing, holdEnding, forget, discard, dismiss, open, anchor }) {
  let window = null;
  let config = null;
  let receivedAt = 0;
  let call = { active: false };
  let callId = 0;
  let phase = "off";
  let listening = null;
  let callHidden = false;
  let hidden = [];
  let prompt = null;
  let busy = false;
  let error = "";
  let disposed = false;
  /** Snoozed prompts by id, until when. Few, and pruned on every render. */
  let snoozed = new Map();
  /** Meetings this pet recorded, so only those say their notes are ready; and the ones already said. Both capped. */
  let recorded = [];
  let announced = [];
  let ready = null;
  /** The recording just discarded, while that can still be undone, and when it really goes (whatever card is showing by then). */
  let undoing = null;
  let undoTimer = null;
  /** A card's own clock: when it goes, or how long it had left while the pointer rests on it. */
  let expiry = null;
  let expiryTimer = null;
  const eventKey = (event) => `${event.eventId}:${event.startsAt}`;
  const position = () => {
    if (!window || window.isDestroyed()) return;
    const pet = anchor?.();
    const area = pet ? screen.getDisplayMatching(pet).workArea : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(prompt?.recording ? 480 : 640, area.width);
    const height = prompt?.recording ? 104 : 136;
    if (!pet) return window.setBounds({ x: area.x + area.width - width, y: area.y + area.height - height - 8, width, height });
    // Beside him, on whichever side has room; what he says goes above him, so the two do not cover each other.
    const left = pet.x - width + WINDOW_MARGIN;
    const right = pet.x + pet.width - WINDOW_MARGIN;
    const x = left >= area.x ? left : right + width <= area.x + area.width ? right : Math.max(area.x, area.x + area.width - width);
    const y = Math.round(Math.min(area.y + area.height - height, Math.max(area.y, pet.y + pet.height / 2 - height / 2)));
    window.setBounds({ x: Math.round(x), y, width, height });
  };
  const send = () => {
    if (!window || window.isDestroyed()) return;
    window.webContents.send("meeting-notice:state", prompt);
    if (prompt) window.showInactive();
    else window.hide();
  };
  const seconds = (ms) => `${Math.max(1, Math.ceil(ms / 1000))}s`;
  const recordingCard = (now) => {
    const id = `recording:${listening.id ?? "starting"}`;
    const title = listening.title ?? "New meeting";
    const menu = true;
    if (phase === "starting") {
      return { id, title, recording: true, menu, primary: { name: "stop", label: "Cancel" },
        detail: listening.error || (listening.progress !== undefined ? `Downloading speech model · ${Math.round(listening.progress * 100)}%` : "Connecting audio…") };
    }
    if (phase === "stopping") return { id, title, recording: true, menu, primary: { name: "stop", label: "Stop", disabled: true }, detail: "Finishing transcript…" };
    if (listening.endingAt || listening.endingLeft) {
      const left = listening.endingAt ? listening.endingAt - now : listening.endingLeft;
      const quiet = listening.ending === "quiet";
      return { id: `${id}:ending`, title: quiet ? "Meeting still going?" : "Call ended", recording: true, menu, hover: "ending",
        detail: `${quiet ? "No one has spoken for 10 min · " : ""}Stopping notes in ${seconds(left)}${listening.endingLeft ? " · paused" : ""}`,
        primary: { name: "keep-going", label: "Keep going" }, secondary: { name: "stop", label: "Stop now" } };
    }
    const elapsedSeconds = Math.max(0, Math.floor((now - (listening.startedAt ?? now)) / 1000));
    const elapsed = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
    // What is wrong with what it hears comes before what it is using to hear.
    const warning = listening.system && listening.system !== "live" ? "Mic only · can't hear the other side"
      : listening.mic && listening.mic !== "live" ? "Computer sound only · can't hear your mic"
      : listening.micQuietMs ? `No sound from your mic for ${Math.floor(listening.micQuietMs / 60_000)} min`
      : listening.behindMs > 15_000 ? `Transcript ${Math.ceil(listening.behindMs / 1000)}s behind` : undefined;
    return { id, title, recording: true, menu, primary: { name: "stop", label: "Stop" },
      warning: Boolean(warning && !/behind/.test(warning)), detail: listening.error || `${elapsed} · ${warning ?? listening.speech ?? "Listening"}` };
  };
  const render = () => {
    if (disposed) return;
    const wasRecording = prompt?.recording;
    const hadCard = Boolean(prompt);
    const previous = JSON.stringify(prompt);
    const now = Date.now();
    for (const [id, until] of snoozed) if (until <= now) snoozed.delete(id);
    const enabled = config && !config.paused && now - receivedAt < 90_000 && phase === "off";
    const detected = enabled && config.notice && call.active && !callHidden && !snoozed.has(`call:${callId}`);
    const event = enabled && config.headsUp ? config.upcoming.filter((item) =>
      !hidden.includes(eventKey(item)) && !snoozed.has(eventKey(item)) && now >= item.startsAt - 120_000 && now < item.endsAt &&
      (now <= item.startsAt + 600_000 || detected)).sort((a, b) => Math.abs(a.startsAt - now) - Math.abs(b.startsAt - now))[0] : undefined;
    const ended = phase === "off" && listening?.ended && listening.ended.words < MISTAKE_WORDS && now - listening.ended.at < MISTAKE_MS + 60_000 ? listening.ended : null;
    if (listening && phase !== "off") prompt = recordingCard(now);
    else if (undoing) {
      prompt = { id: `undo:${undoing}`, undoing, title: "Recording discarded", detail: "Its notes won't be written.", closable: true,
        primary: { name: "undo", label: "Undo" } };
    } else if (ended) {
      prompt = { id: `mistake:${ended.id}`, ended: ended.id, title: "Started by mistake?", closable: true, timeoutMs: MISTAKE_MS, timeoutAction: "keep",
        detail: ended.words === 0 ? "Nothing was heard." : `Only ${ended.words} word${ended.words === 1 ? "" : "s"} were heard.`,
        primary: { name: "keep", label: "Keep" }, secondary: { name: "discard", label: "Discard" } };
    } else if (ready && !config?.paused) {
      prompt = { id: `ready:${ready.id}`, meeting: ready.id, title: "Your notes are ready", detail: ready.title, closable: true,
        timeoutMs: READY_MS, timeoutAction: "dismiss", primary: { name: "view", label: "View notes" } };
    } else if (enabled && !busy && (event || detected)) {
      prompt = {
        id: event ? eventKey(event) : `call:${callId}`,
        title: event?.title ?? (call.app ? "Meeting detected" : "On a call?"),
        detail: error || (detected ? [call.app, "Now"].filter(Boolean).join(" · ") : event.startsAt > now ? `Starts in ${Math.ceil((event.startsAt - now) / 60_000)} min` : "Now"),
        detected: Boolean(detected), event, menu: true, closable: true,
        // A calendar meeting is worth asking about until it starts; a call the probe guessed is not worth nagging about.
        ...(event ? {} : { timeoutMs: CALL_ASKS_MS, timeoutAction: "dismiss" }),
        primary: { name: "start", label: "Start Notetaker" },
      };
    } else prompt = null;
    if (prompt?.id !== expiry?.id) {
      clearTimeout(expiryTimer);
      expiry = prompt?.timeoutMs ? { id: prompt.id, at: now + prompt.timeoutMs } : null;
      if (expiry) expiryTimer = setTimeout(expire, prompt.timeoutMs);
    }
    if (JSON.stringify(prompt) === previous) return;
    if (window && (wasRecording !== prompt?.recording || (prompt && !hadCard))) position();
    if (prompt && !window) {
      window = new BrowserWindow({ width: 640, height: 136, show: false, frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: true,
        webPreferences: { preload: join(here, "meeting-notice-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
      // Meeting titles and the fact of recording are not for whoever the owner is sharing their screen with.
      window.setContentProtection(true);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      if (process.platform === "darwin") window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.webContents.on("did-finish-load", send);
      window.on("close", (event) => { if (!disposed) { event.preventDefault(); act("dismiss"); } });
      window.on("closed", () => { window = null; });
      position();
      void window.loadFile(join(here, "meeting-notice.html"));
    } else send();
  };
  /** The card's time is up: it does what its timeout says, as though clicked. */
  const expire = () => {
    if (!prompt || prompt.id !== expiry?.id) return;
    expiry = null;
    act(prompt.timeoutAction);
  };
  const hover = (resting) => {
    if (prompt?.hover === "ending") { holdEnding?.(resting); return; }
    if (!expiry || expiry.id !== prompt?.id) return;
    clearTimeout(expiryTimer);
    if (resting && expiry.at) expiry = { id: expiry.id, left: Math.max(0, expiry.at - Date.now()) };
    else if (!resting && expiry.left !== undefined) {
      const left = Math.max(expiry.left, AFTER_HOVER_MS);
      expiry = { id: expiry.id, at: Date.now() + left };
      expiryTimer = setTimeout(expire, left);
    }
  };
  const hidePrompt = () => {
    const event = prompt?.event;
    if (event) {
      hidden = [...hidden.filter((id) => id !== eventKey(event)), eventKey(event)].slice(-20);
      void dismiss(event.eventId).catch((error) => console.warn("Meeting dismissal wasn't saved:", error.message));
    }
    if (call.active) callHidden = true;
    error = "";
    render();
  };
  const snooze = () => {
    if (!prompt || prompt.recording) return;
    // The 15 s heartbeat brings it back once the snooze is over.
    snoozed.set(prompt.event ? eventKey(prompt.event) : `call:${callId}`, Date.now() + SNOOZE_MS);
    render();
  };
  const begin = async (joinCall = false) => {
    if (!prompt || busy) return;
    const event = prompt.event;
    busy = true;
    error = "";
    render();
    try {
      const result = await start(event ? { title: event.title, eventId: event.eventId, ...(joinCall && event.joinUrl ? { joinUrl: event.joinUrl } : {}) } : {});
      if (result?.error) error = result.error;
      else {
        if (call.active) callHidden = true;
        if (event) hidden = [...hidden, eventKey(event)].slice(-20);
      }
    } catch { error = "Couldn't start. Check Perry's connection and try again."; }
    finally { busy = false; render(); }
  };
  const discardNow = () => {
    clearTimeout(undoTimer);
    if (!undoing) return;
    const id = undoing;
    undoing = null;
    void discard?.(id).catch((error) => console.warn("The meeting wasn't discarded:", error.message));
  };
  /** What each button, key and timeout does, for the card on screen now. */
  const act = (name) => {
    if (!prompt) return;
    const card = prompt;
    if (name === "start" && !card.recording && !card.primary?.disabled) void begin();
    else if (name === "stop" && card.recording && !card.primary?.disabled) void stop?.();
    else if (name === "keep-going" && card.recording) keepGoing?.();
    else if (name === "keep" && card.ended) forget?.();
    else if (name === "discard" && card.ended) {
      discardNow();
      undoing = card.ended;
      undoTimer = setTimeout(() => { discardNow(); render(); }, UNDO_DISCARD_MS);
      forget?.();
      render();
    } else if (name === "undo" && card.undoing) {
      clearTimeout(undoTimer);
      undoing = null;
      render();
    } else if (name === "dismiss" && card.undoing) {
      discardNow();
      render();
    } else if (name === "view" && card.meeting) { ready = null; open(`/meetings/${card.meeting}`); render(); }
    else if (name === "dismiss" && card.ended) forget?.();
    else if (name === "dismiss" && card.meeting) { ready = null; render(); }
    else if (name === "dismiss" && !card.recording) hidePrompt();
  };
  const action = (event, name, id) => {
    if (event.sender !== window?.webContents || !prompt || id !== prompt.id) return;
    if (name === "hover" || name === "leave") hover(name === "hover");
    else if (name === "menu") {
      const card = prompt;
      Menu.buildFromTemplate(card.recording ? [
        { label: "Open meeting notes", click: () => open(listening?.id ? `/meetings/${listening.id}` : "/meetings") },
      ] : [
        ...(card.event?.joinUrl ? [{ label: "Join & start Notetaker", click: () => { if (prompt?.id === id) void begin(true); } }] : []),
        { label: "Snooze for 2 min", click: () => { if (prompt?.id === id) snooze(); } },
        { label: "Open Meetings", click: () => open("/meetings") },
        { type: "separator" },
        { label: "Not now", click: () => { if (prompt?.id === id) hidePrompt(); } },
      ]).popup({ window });
    } else act(name);
  };
  ipcMain.on("meeting-notice:action", action);
  screen.on("display-metrics-changed", position);
  const timer = setInterval(render, 15_000);
  return {
    configure(next) {
      if (!next || !Array.isArray(next.upcoming)) return;
      config = { paused: next.paused === true, headsUp: next.headsUp === true, notice: next.notice === true,
        upcoming: next.upcoming.filter((event) => typeof event.eventId === "string" && typeof event.title === "string" && Number.isFinite(event.startsAt) && Number.isFinite(event.endsAt)).slice(0, 20) };
      receivedAt = Date.now();
      hidden = hidden.filter((id) => config.upcoming.some((event) => eventKey(event) === id));
      render();
    },
    call(next) { if (!next.active) callHidden = false; if (next.active && !call.active) callId++; call = next; render(); },
    listening(state) {
      phase = state.phase;
      listening = state;
      if (state.id && !recorded.includes(state.id)) recorded = [...recorded, state.id].slice(-10);
      render();
    },
    /** He was moved: the card goes with him. */
    moved() { if (prompt) position(); },
    /** The pet's page saw a meeting's notes written: said once, and only for one this pet recorded. */
    written(next) {
      if (!next || typeof next.id !== "string" || typeof next.title !== "string") return;
      if (!recorded.includes(next.id) || announced.includes(next.id)) return;
      announced = [...announced, next.id].slice(-20);
      ready = { id: next.id, title: next.title };
      render();
    },
    dispose() {
      discardNow();
      disposed = true;
      clearInterval(timer);
      clearTimeout(expiryTimer);
      ipcMain.off("meeting-notice:action", action);
      screen.off("display-metrics-changed", position);
      window?.destroy();
      window = null;
      config = null;
      hidden = [];
      snoozed = new Map();
      recorded = [];
      announced = [];
    },
  };
}
