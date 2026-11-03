import { BrowserWindow, Menu, ipcMain, screen } from "electron";
import { join } from "node:path";

/** One small native window survives pet page reloads; all calendar data is replaced on each heartbeat. */
export function meetingNotice({ here, start, dismiss, open }) {
  let window = null;
  let config = null;
  let receivedAt = 0;
  let call = { active: false };
  let callId = 0;
  let phase = "off";
  let callHidden = false;
  let hidden = [];
  let prompt = null;
  let busy = false;
  let error = "";
  let disposed = false;
  const eventKey = (event) => `${event.eventId}:${event.startsAt}`;
  const position = () => {
    if (!window || window.isDestroyed()) return;
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(640, area.width);
    window.setBounds({ x: area.x + area.width - width, y: area.y + area.height - 144, width, height: 136 });
  };
  const send = () => {
    if (!window || window.isDestroyed()) return;
    window.webContents.send("meeting-notice:state", prompt);
    if (prompt) window.showInactive();
    else window.hide();
  };
  const render = () => {
    if (disposed) return;
    const previous = JSON.stringify(prompt);
    const now = Date.now();
    const enabled = config && !config.paused && now - receivedAt < 90_000 && phase === "off";
    const detected = enabled && config.notice && call.active && !callHidden;
    const event = enabled && config.headsUp ? config.upcoming.filter((item) =>
      !hidden.includes(eventKey(item)) && now >= item.startsAt - 120_000 && now < item.endsAt &&
      (now <= item.startsAt + 600_000 || detected)).sort((a, b) => Math.abs(a.startsAt - now) - Math.abs(b.startsAt - now))[0] : undefined;
    prompt = enabled && !busy && (event || detected) ? {
      id: event ? eventKey(event) : `call:${callId}`,
      title: event?.title ?? (call.app ? "Meeting detected" : "On a call?"),
      detail: error || (detected ? [call.app, "Now"].filter(Boolean).join(" · ") : event.startsAt > now ? `Starts in ${Math.ceil((event.startsAt - now) / 60_000)} min` : "Now"),
      detected: Boolean(detected), event,
    } : null;
    if (JSON.stringify(prompt) === previous) return;
    if (prompt && !window) {
      window = new BrowserWindow({ width: 640, height: 136, show: false, frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: true,
        webPreferences: { preload: join(here, "meeting-notice-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      if (process.platform === "darwin") window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.webContents.on("did-finish-load", send);
      window.on("close", (event) => { if (!disposed) { event.preventDefault(); hidePrompt(); } });
      window.on("closed", () => { window = null; });
      position();
      void window.loadFile(join(here, "meeting-notice.html"));
    } else send();
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
  const action = (event, name, id) => {
    if (event.sender !== window?.webContents || !prompt || id !== prompt.id) return;
    if (name === "start") void begin();
    else if (name === "dismiss") hidePrompt();
    else if (name === "menu") Menu.buildFromTemplate([
      ...(prompt.event?.joinUrl ? [{ label: "Join & start Notetaker", click: () => { if (prompt?.id === id) void begin(true); } }] : []),
      { label: "Open Meetings", click: () => open("/meetings") },
      { type: "separator" },
      { label: "Not now", click: () => { if (prompt?.id === id) hidePrompt(); } },
    ]).popup({ window });
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
    listening(state) { phase = state.phase; render(); },
    dispose() {
      disposed = true;
      clearInterval(timer);
      ipcMain.off("meeting-notice:action", action);
      screen.off("display-metrics-changed", position);
      window?.destroy();
      window = null;
      config = null;
      hidden = [];
    },
  };
}
