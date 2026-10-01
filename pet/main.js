/**
 * Perry on the desktop: a small window on top of everything that shows the
 * pet page from Perry's own server (app/pet), where the platypus stands with
 * the owner's to-do list. The window is transparent and lets clicks through,
 * except where the page says there is something to click; it sits in a
 * corner of the screen and goes where it is dragged; dragged onto the circle
 * that appears at the bottom middle of the screen, he hides. A tray icon
 * shows, hides, restarts and quits it.
 *
 * `perry pet` installs Electron here (pnpm, in this folder), starts this, and
 * has it start at login; `perry pet off` stops both. On the owner's other
 * computers, the installer's pet-only mode does the same, and connect.js pairs
 * him with Perry's server over the network. Everything the pet knows comes
 * from the server, so this file keeps only where the window stands, and on
 * another computer which server and its key for him.
 *
 * Run again while running, it acts on the one already there: --quit quits it,
 * --reload reloads its page (after `perry update`), anything else shows it.
 */

import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, nativeTheme, powerMonitor, screen, shell } from "electron";
import { existsSync, mkdirSync, readFileSync, watchFile, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCREEN_RECORDING_SETTINGS, capture, lookKey } from "./look.js";
import { DEFAULT_HOTKEY, hotkeys, transcribe, warmUp } from "./voice.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const HOME = process.env.PERRY_HOME ?? join(homedir(), ".perry");
const STATE = join(HOME, "pet.json");
/** Where the voice model is kept once downloaded. */
const MODELS = process.env.PERRY_MODELS_DIR ?? join(HOME, "models");
/** Room for the platypus and his bubble or panel: above him, or below him near the top of a screen. */
const SIZE = { width: 404, height: 620 };
/** The part of the window he stands in, at its bottom-right corner away from the edges of the screen. */
const BODY = { width: 150, height: 170 };
/**
 * Dragged onto this, he goes: a circle at the bottom middle of the screen,
 * there only while he is being dragged. He is hidden, not quit, so the
 * hotkey, his tray icon or `perry pet` bring him back, to where he was.
 */
const DISMISS = { size: 220, reach: 70 };
/**
 * The circle's page, in Perry's colours (app/globals.css: popover, foreground,
 * border, destructive, and the overlay shadow), light or dark as his theme is:
 * nativeTheme, from pet.json, is what this page sees as the system's. It is a
 * data: URL, made before Perry's server may be up (at login, or restarting to
 * update), so it cannot load the app's font; two words in the system's own
 * font, rather than a circle that waits on the server.
 */
const DISMISS_PAGE = `<!doctype html><html><head><title>Perry: drop here to hide</title><meta name="color-scheme" content="light dark"><style>
:root{--popover:#ffffff;--foreground:#1d1d1f;--border:#e5e5ea;--destructive:#c4221a;--on-destructive:#ffffff}
@media (prefers-color-scheme:dark){:root{--popover:#18181b;--foreground:#f2f2f4;--border:rgb(255 255 255/.09);--destructive:#ff7a70;--on-destructive:#0c0c0e}}
body{margin:0;height:100vh;display:grid;place-items:center;background:transparent;font:600 12px system-ui,sans-serif}
#all{display:grid;justify-items:center;gap:10px;margin-top:34px;opacity:0;transition:opacity .12s}
#ring,#label{background:var(--popover);color:var(--foreground);border:1px solid var(--border);box-shadow:0 16px 40px -12px rgb(0 0 0/.38)}
#ring{width:110px;height:110px;box-sizing:border-box;border-radius:50%;display:grid;place-items:center;transition:transform .15s,background .15s,color .15s}
#label{padding:3px 9px;border-radius:99px}
body.armed #ring{transform:scale(1.2);background:var(--destructive);color:var(--on-destructive);border-color:transparent}
</style></head><body>
<div id="all"><div id="ring"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></div>
<div id="label">Hide Perry</div></div>
<script>window.shown=(on)=>{all.style.opacity=on?"1":"0";};window.arm=(on)=>{document.body.classList.toggle("armed",on);label.textContent=on?"Let go to hide him":"Hide Perry";}</script>
</body></html>`;

/** The checkout's .env.local, where the dashboard key and any PERRY_PORT live. */
function envFile() {
  const values = {};
  const file = join(REPO, ".env.local");
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0 && !line.trimStart().startsWith("#")) values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return values;
}

function readState() {
  try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return {}; }
}

/**
 * Which Perry he shows, and with what key. On Perry's own computer, the
 * checkout's .env.local: the dashboard key, and the port. On another
 * computer, paired from Perry's Settings → Desktop pet (connect.js), pet.json:
 * the server's address and this computer's own key, which opens only what
 * his page needs. Read again when he is started again (a new pairing).
 */
function connection() {
  const env = envFile();
  const { server, token } = readState();
  if (!process.env.DASHBOARD_KEY && typeof server === "string" && typeof token === "string") return { base: server.replace(/\/+$/, ""), key: token, paired: true };
  return {
    base: process.env.PERRY_URL ?? `http://127.0.0.1:${process.env.PERRY_PORT ?? env.PERRY_PORT ?? 7377}`,
    key: process.env.DASHBOARD_KEY ?? env.DASHBOARD_KEY ?? "",
    paired: false,
  };
}
let { base: BASE, key: KEY, paired: PAIRED } = connection();

function saveState(patch) {
  try {
    mkdirSync(HOME, { recursive: true });
    writeFileSync(STATE, JSON.stringify({ ...readState(), ...patch }, null, 2));
  } catch (error) {
    console.error(`could not save where the pet is: ${error}`);
  }
}

/** The part of the screen he stands on that windows may use, for his spot. */
const areaOf = (x, y) => screen.getDisplayNearestPoint({ x: x + SIZE.width - BODY.width / 2, y: y + SIZE.height - BODY.height / 2 }).workArea;
const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

/**
 * Where he may stand: anywhere, so long as he is on a screen. His spot is
 * where his window would be with him in its bottom-right corner, as it is
 * away from the edges; it is what pet.json keeps.
 */
function keepOnScreen(x, y) {
  const area = areaOf(x, y);
  return {
    x: Math.round(clamp(x, area.x - (SIZE.width - BODY.width), area.x + area.width - SIZE.width)),
    y: Math.round(clamp(y, area.y - (SIZE.height - BODY.height), area.y + area.height - SIZE.height)),
  };
}

/**
 * His window, for him at a spot: always wholly on his screen, so his bubble
 * and panel are too. Near the top of the screen it hangs below him, and they
 * open under him, unless there is more room above; near the left edge he
 * stands further left in it, and they open over to his right. He is not
 * moved: his page is told where he is in the window (`place`: how far up and
 * left of its bottom-right corner, and whether they open below him).
 */
function frame(spot) {
  const area = areaOf(spot.x, spot.y);
  const above = spot.y + SIZE.height - BODY.height - area.y;
  const under = area.y + area.height - (spot.y + SIZE.height);
  const below = above < SIZE.height - BODY.height && under > above;
  const x = clamp(spot.x, area.x, area.x + area.width - SIZE.width);
  const y = clamp(below ? spot.y + SIZE.height - BODY.height : spot.y, area.y, area.y + area.height - SIZE.height);
  return { bounds: { x, y, ...SIZE }, place: { x: spot.x - x, y: spot.y - y, below } };
}

function startingPlace() {
  const saved = readState();
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) return keepOnScreen(saved.x, saved.y);
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - SIZE.width, y: area.y + area.height - SIZE.height };
}

if (process.platform === "linux") app.commandLine.appendSwitch("enable-transparent-visuals");
// One pet per Perry: a Perry with its own PERRY_HOME (another checkout, or a test) keeps his lock (one of him at
// a time) and his page's storage there, so its pet never answers for, or quits, the one in ~/.perry.
if (process.env.PERRY_HOME) app.setPath("userData", join(HOME, "pet-window"));
// For looking inside his page with DevTools, as the end-to-end check does (artifacts/desktop-pet).
if (process.env.PERRY_PET_DEVTOOLS_PORT) app.commandLine.appendSwitch("remote-debugging-port", process.env.PERRY_PET_DEVTOOLS_PORT);
// A recording in place of the microphone, for the same check: it plays once, each time he listens.
if (process.env.PERRY_PET_FAKE_MIC) {
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-file-for-fake-audio-capture", `${process.env.PERRY_PET_FAKE_MIC}%noloop`);
}

const argv = process.argv.slice(1);
/**
 * --restart (with --quit, which every version of him obeys): a pet on new
 * code takes over from the one running (`perry update` after his own files
 * changed). The running one quits; this one starts again as --takeover until
 * it gets his lock, a few seconds at most. With none running, nothing starts.
 */
const TAKEOVER_TRIES = 40;
const takeover = Number(argv.find((arg) => arg.startsWith("--takeover="))?.split("=")[1] ?? 0);
const startAgain = (n) => {
  app.relaunch({ args: [...argv.filter((arg) => arg !== "--quit" && arg !== "--restart" && !arg.startsWith("--takeover=")), `--takeover=${n}`] });
  app.exit(0);
};
if (!app.requestSingleInstanceLock({ argv })) {
  // The one already running was told (second-instance, below). Taking over from it, try again in a moment, once it has gone.
  if (argv.includes("--restart")) setTimeout(() => startAgain(1), 500);
  else if (takeover > 0 && takeover < TAKEOVER_TRIES) setTimeout(() => startAgain(takeover + 1), 250);
  else app.quit();
} else if (argv.includes("--quit") || argv.includes("--reload")) {
  // Asked to act on a pet that was not running: there is nothing to quit or reload.
  app.quit();
} else {
  let win = null;
  let tray = null;
  /** Ghost: every click goes through him, even on him. */
  let ghost = Boolean(readState().ghost);
  let saveTimer = null;
  /** Where he stands (see keepOnScreen), and his window for it (frame). */
  let spot = null;
  let framed = null;
  /** He stands at a spot: his window goes where it keeps all of him on screen, and his page hears where he is in it. */
  const standAt = (to) => {
    spot = to;
    framed = frame(spot);
    // The size is set with the place each time: on a scaled screen, moving alone can grow a window a pixel at a time.
    win?.setBounds(framed.bounds);
    win?.webContents.send("pet:place", framed.place);
  };
  /** Where his body's middle is on the screen, for the screen he is on. */
  const bodyPoint = () => ({ x: spot.x + SIZE.width - BODY.width / 2, y: spot.y + SIZE.height - BODY.height / 2 });
  /** While he is dragged: the circle to drop him on, whether he is over it, where he came from, and where his body is from his spot. */
  let dismiss = null;
  let dragging = false;
  let armed = false;
  let dragFrom = null;
  let body = null;
  /** Whether the owner wants him on screen; the tray's Hide says no. */
  let wanted = true;
  /**
   * The hotkey that talks to him: the one last set (Settings → Keyboard
   * shortcuts, kept in pet.json so it works before his page loads), or the
   * default. `hotkeyError` says why he does not have the one asked for.
   */
  let voice = null;
  let hotkeyError = null;
  /** The hotkey that shows him the screen (look.js), and why he does not have the one asked for. */
  let look = null;
  let lookError = null;
  const voiceTo = (type) => {
    // Talking to him brings him back if he was hidden, without taking the focus from what you are in.
    if (type === "start" && win && !win.isVisible()) show();
    win?.webContents.send("pet:voice", type);
  };

  /**
   * A picture of the window the owner is in and of the screen (look.js), for
   * the owner (`byOwner`: the Look hotkey, his chat's button) or for Perry. While
   * macOS does not allow it, the first time is macOS's own question; after
   * that, the owner asking opens System Settings where they allow it. Whether
   * it has asked is kept in pet.json: macOS tells an app only yes or no.
   */
  const shoot = async (byOwner) => {
    const shot = await capture([win, dismiss], bodyPoint()).catch((error) => ({ error: String(error) }));
    if (shot.needs === "screen-recording") {
      if (!readState().screenRecordingAsked) saveState({ screenRecordingAsked: true });
      else if (byOwner) void shell.openExternal(SCREEN_RECORDING_SETTINGS);
    }
    return shot;
  };

  /** A picture of the window the owner is in and of the screen, into his chat to ask about; he comes up, ready for the question. */
  const lookNow = async () => {
    if (!win) return;
    const shot = await shoot(true);
    show();
    win.webContents.send("pet:look", shot);
    win.focus();
  };

  const load = () => win?.loadURL(`${BASE}/pet#key=${encodeURIComponent(KEY)}`).catch(() => {});
  /**
   * A page of the dashboard in the owner's browser, unlocked as `perry open`
   * does; only this server's own pages. Paired from another computer, his key
   * opens only his own page, so the dashboard asks for its key there, once.
   */
  const openDashboard = (path) => {
    const page = typeof path === "string" && path.startsWith("/") && !path.startsWith("//") ? path : "/";
    void shell.openExternal(PAIRED ? `${BASE}${page}` : `${BASE}${page}#key=${encodeURIComponent(KEY)}`);
  };

  const show = () => { wanted = true; if (win && !win.isVisible()) win.showInactive(); refreshMenu(); };
  const hide = () => { wanted = false; win?.hide(); refreshMenu(); };

  function dismissWindow() {
    const area = screen.getPrimaryDisplay().workArea;
    const target = new BrowserWindow({
      x: Math.round(area.x + (area.width - DISMISS.size) / 2), y: area.y + area.height - DISMISS.size - 8,
      width: DISMISS.size, height: DISMISS.size, frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
      resizable: false, movable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, show: false,
      // It must redraw the moment he is over it, though it was hidden a moment ago.
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
    });
    target.setAlwaysOnTop(true, "floating");
    target.setIgnoreMouseEvents(true);
    target.webContents.once("did-finish-load", () => target.showInactive());
    void target.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(DISMISS_PAGE)}`);
    return target;
  }

  function refreshMenu() {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Perry", enabled: false },
      wanted ? { label: "Hide", click: hide } : { label: "Show", click: show },
      { label: "Let clicks through him", type: "checkbox", checked: ghost, click: (item) => {
        ghost = item.checked;
        saveState({ ghost });
        win?.setIgnoreMouseEvents(true, { forward: !ghost });
        refreshMenu();
      } },
      { type: "separator" },
      voice?.current()
        ? { label: `Talk to him (${voice.current().replace("CommandOrControl", process.platform === "darwin" ? "Cmd" : "Ctrl")})`, click: () => voice.start() }
        : { label: "Talk to him: his keys are taken by another app", enabled: false },
      { label: `Show him the screen${look?.current() ? ` (${look.current().replace("CommandOrControl", process.platform === "darwin" ? "Cmd" : "Ctrl")})` : ""}`, click: () => void lookNow() },
      { label: "Keyboard shortcuts…", click: () => openDashboard("/settings?tab=shortcuts") },
      { label: "Open Perry", click: () => openDashboard("/") },
      { label: "Put him back in the corner", click: () => {
        const area = screen.getPrimaryDisplay().workArea;
        standAt({ x: area.x + area.width - SIZE.width, y: area.y + area.height - SIZE.height });
        saveState({ x: undefined, y: undefined });
      } },
      { type: "separator" },
      // Starting again is what a permission given on a Mac (Screen Recording, for looking at the screen) needs.
      { label: "Restart", click: () => startAgain(1) },
      { label: "Quit", click: () => app.quit() },
    ]));
  }

  app.on("second-instance", (_event, _commandLine, _cwd, data) => {
    const args = data?.argv ?? [];
    if (args.includes("--quit")) return app.quit();
    // Paired again (connect.js starts him): another server or key, and his page from it.
    const now = connection();
    const changed = now.base !== BASE || now.key !== KEY;
    ({ base: BASE, key: KEY, paired: PAIRED } = now);
    if (args.includes("--reload") || changed) load();
    if (!args.includes("--reload")) show();
  });

  app.whenReady().then(() => {
    // One name for the system's notifications.
    if (process.platform === "win32") app.setAppUserModelId("Perry");
    // On a Mac, no Dock icon or app switcher entry: he is a helper on the screen, not an app you switch to.
    if (process.platform === "darwin") app.setActivationPolicy("accessory");
    app.dock?.hide();

    // His theme, light, dark or the system's, from pet.json, where the dashboard saves it (Settings → Desktop pet).
    // It is what his page sees as the system's, so it follows as soon as it changes, without a reload.
    const applyTheme = () => {
      const theme = readState().theme;
      nativeTheme.themeSource = theme === "light" || theme === "dark" ? theme : "system";
    };
    applyTheme();
    watchFile(STATE, { interval: 1000 }, applyTheme);

    spot = startingPlace();
    framed = frame(spot);
    win = new BrowserWindow({
      ...framed.bounds,
      title: "Perry",
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: join(HERE, "preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        // He keeps counting down while nothing else is on screen.
        backgroundThrottling: false,
      },
    });
    win.setAlwaysOnTop(true, "floating");
    // skipTransformProcessType: otherwise macOS turns him back into a regular app for this, and his Dock icon comes back.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false, skipTransformProcessType: true });
    // Clicks pass through until the page says the pointer is on him (pet:solid); forwarded, so it can tell.
    win.setIgnoreMouseEvents(true, { forward: !ghost });

    // He appears once his page is there, without taking the focus from what the owner is doing.
    win.webContents.on("did-finish-load", () => { if (wanted && !win.isVisible()) win.showInactive(); });
    // Perry's server may not be up yet (at login) or may be restarting (an update): out of sight, try again until it is.
    win.webContents.on("did-fail-load", (_event, _code, _description, _url, mainFrame) => {
      if (!mainFrame) return;
      win.hide();
      setTimeout(load, 3000);
    });
    win.webContents.on("render-process-gone", () => setTimeout(load, 1000));
    // The page stays the pet; any link opens in the browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(`${BASE}/pet`)) {
        event.preventDefault();
        if (/^https?:/.test(url)) void shell.openExternal(url);
      }
    });
    // Other windows asking to be on top do not push him under for long.
    setInterval(() => {
      if (!win?.isVisible()) return;
      win.setAlwaysOnTop(true, "floating");
      win.moveTop();
    }, 15_000);
    // A screen unplugged may take him with it; one changed (its size, its scale, the taskbar) may leave less room around him.
    const restand = () => standAt(keepOnScreen(spot.x, spot.y));
    screen.on("display-removed", restand);
    screen.on("display-metrics-changed", restand);
    // His page asks where he is in his window, and hears each time that changes (pet:place).
    ipcMain.handle("pet:place", () => framed.place);

    ipcMain.on("pet:solid", (_event, on) => {
      if (!ghost) win.setIgnoreMouseEvents(!on, { forward: true });
    });
    ipcMain.on("pet:move", (_event, x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const place = keepOnScreen(x, y);
      standAt(place);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveState(place), 500);
      if (dragging && body) {
        const [cx, cy] = [place.x + body.x, place.y + body.y];
        const target = dismiss.getBounds();
        const over = Math.hypot(cx - (target.x + target.width / 2), cy - (target.y + target.height / 2)) < DISMISS.reach;
        if (over !== armed) {
          armed = over;
          void dismiss.webContents.executeJavaScript(`arm(${armed})`).catch(() => {});
          win.webContents.send("pet:armed", armed);
        }
      }
    });
    // A drag starts: the circle appears at the bottom middle of his screen. It ends: over the circle, he goes.
    ipcMain.on("pet:drag", (_event, phase, bodyX, bodyY) => {
      if (phase === "start") {
        dragFrom = spot;
        // The page says where his body is in his window; taken from his spot, it holds however the window is placed.
        body = Number(bodyX) && Number(bodyY)
          ? { x: Number(bodyX) - framed.place.x, y: Number(bodyY) - framed.place.y }
          : { x: SIZE.width - 68, y: SIZE.height - 69 };
        const area = screen.getDisplayNearestPoint({ x: dragFrom.x + body.x, y: dragFrom.y + body.y }).workArea;
        dismiss.setBounds({ x: Math.round(area.x + (area.width - DISMISS.size) / 2), y: area.y + area.height - DISMISS.size - 8, width: DISMISS.size, height: DISMISS.size });
        armed = false;
        // Its window is always there, see-through; it fades in, above whatever else is on top, and he above it.
        void dismiss.webContents.executeJavaScript("arm(false); shown(true)").catch(() => {});
        dragging = true;
        dismiss.moveTop();
        win.moveTop();
        return;
      }
      dragging = false;
      void dismiss?.webContents.executeJavaScript("shown(false)").catch(() => {});
      if (armed && dragFrom) {
        armed = false;
        win.webContents.send("pet:armed", false);
        hide();
        // Back to where he was, for when he is shown again.
        clearTimeout(saveTimer);
        standAt(dragFrom);
        saveState(dragFrom);
        if (Notification.isSupported()) {
          const keys = voice?.current()?.replace("CommandOrControl", process.platform === "darwin" ? "Cmd" : "Ctrl");
          new Notification({ title: "Perry is out of sight", body: `${keys ? `Press ${keys}, or click` : "Click"} his icon in the tray, to bring him back.`, silent: true }).show();
        }
      }
      dragFrom = null;
    });
    ipcMain.handle("pet:idle", () => powerMonitor.getSystemIdleTime());
    // What was said, as text: the page records, this listens.
    ipcMain.handle("pet:transcribe", async (_event, samples) => {
      try {
        const text = await transcribe(MODELS, samples, (progress) => win?.webContents.send("pet:voice-progress", progress));
        return { text };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.on("pet:voice-done", () => voice?.done());
    voice = hotkeys(voiceTo);
    const take = (accelerator) => {
      const result = voice.change(accelerator);
      hotkeyError = result.error ?? null;
      if (result.hotkey) saveState({ hotkey: result.hotkey });
      refreshMenu();
      return standing();
    };
    // The page asks for the keys the dashboard has; he answers with the ones he holds, and why not, if not; and why only tapping works, if so.
    const standing = () => ({ hotkey: voice.current(), error: hotkeyError, hold: voice.hold() });
    ipcMain.handle("pet:hotkey", standing);
    ipcMain.handle("pet:set-hotkey", (_event, accelerator) => typeof accelerator === "string" ? take(accelerator) : standing());
    const saved = readState().hotkey ?? process.env.PERRY_PET_HOTKEY ?? DEFAULT_HOTKEY;
    if (take(saved).error && saved !== DEFAULT_HOTKEY) take(DEFAULT_HOTKEY);
    warmUp(MODELS);
    ipcMain.on("pet:open", (_event, path) => openDashboard(path));
    // Looking at the screen: his chat's button and Perry's look_at_screen ask for the picture; the Look hotkey sends it to the page.
    ipcMain.handle("pet:look", async (_event, byOwner) => await shoot(byOwner === true));
    look = lookKey(() => void lookNow());
    ipcMain.handle("pet:set-look-hotkey", (_event, accelerator) => {
      if (typeof accelerator === "string") {
        const result = look.change(accelerator);
        lookError = result.error ?? null;
        refreshMenu();
      }
      return { hotkey: look.current(), error: lookError };
    });

    // icon.png is 16 points; Electron takes icon@2x.png beside it on a scaled screen.
    // The circle that hides him, made now and always there, see-through, until he is dragged.
    dismiss = dismissWindow();
    tray = new Tray(nativeImage.createFromPath(join(HERE, "icon.png")));
    tray.setToolTip("Perry");
    tray.on("click", () => (wanted ? hide() : show()));
    refreshMenu();

    load();
  });

  // He lives in the tray: closing his window is not quitting.
  app.on("window-all-closed", () => {});
}
