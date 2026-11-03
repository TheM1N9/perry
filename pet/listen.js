/**
 * Listening to a call: both sides of it, for the owner, with nothing added to
 * the call. Only the owner starts it (his bubble, the Listen hotkey, his tray,
 * the dashboard); Perry has no tool for it, so nothing said to him, or in a
 * page he read, can turn it on. While it runs he shows it. Sound is never kept:
 * words go to Perry's server as they are made, and a crash loses only what was
 * being said.
 *
 * Three parts, and each can go without the others noticing:
 *   the hidden window (meeting.html)  hears, and cuts what it hears into chunks;
 *   the worker (listen-worker.js)     makes the chunks into words, one at a time;
 *   this, in his window's process     queues the chunks, and sends the words.
 *
 * The hidden window is not his page, which is replaced each time it reloads
 * (main.js, makeWindow), when Perry's server updates for one: the call goes on.
 *
 * On Windows and a Mac (14.2 or later) Electron hears what the computer plays.
 * On Linux it cannot, so only the microphone is heard, and the owner is told.
 * A Mac that has not allowed "System Audio Recording" gets an audio track that
 * has already ended, with no error: meeting-page.js looks, and the owner is
 * told that too rather than getting half a transcript.
 */

import { BrowserWindow, desktopCapturer, ipcMain, session as sessions, utilityProcess } from "electron";
import { join } from "node:path";

/** More sound than this waiting to be written down (a slow computer), and the oldest goes, and the owner is told. */
const MOST_BEHIND_MS = 15 * 60_000;
/** Words that could not be sent are tried again this often: Perry's server may be restarting. */
const RETRY_MS = 5_000;
/** After this long trying, words still unsent are given up on, so a stopped meeting does not hold on for ever. */
const GIVE_UP_MS = 10 * 60_000;
/** A meeting says it is still being listened to this often; one that stops saying so was cut off (convex/meetings.ts). */
const ALIVE_MS = 30_000;
/** Whisper falling over this many times in one meeting, it stays down. */
const MOST_CRASHES = 3;
const BATCH = 40;
/** The page's last words on stopping, waited for this long. */
const LAST_WORDS_MS = 3_000;

/**
 * `call(path, args)` calls Perry's server as his page does. `tell(state)` hears
 * each change: { phase: "off" | "starting" | "listening" | "stopping", id, title,
 * startedAt, mic, system, behindMs, droppedMs, progress, error }.
 */
export function listener({ here, models, call, tell }) {
  let current = null;
  let otherCall = null;
  /** Why the last one ended early, until the next begins. */
  let lastError = null;

  const view = () => current
    ? { phase: current.phase, id: current.id, title: current.title, startedAt: current.startedAt, mic: current.mic, system: current.system, behindMs: behind(current), droppedMs: current.droppedMs, callActive: otherCall, ...(current.progress ? { progress: current.progress } : {}) }
    : { phase: "off", callActive: otherCall, ...(lastError ? { error: lastError } : {}) };
  const report = () => tell(view());
  const behind = (session) => session.queue.reduce((sum, chunk) => sum + chunk.endMs - chunk.startMs, 0);

  function forkWorker(session) {
    const worker = utilityProcess.fork(join(here, "listen-worker.js"), [models], {
      serviceName: "Perry listening", stdio: "ignore",
      // Electron's own .app on a Mac is signed ad hoc, and ONNX Runtime's library is not signed at all.
      allowLoadingUnsignedLibraries: true,
    });
    worker.on("message", (message) => onWorker(session, message));
    worker.on("exit", () => {
      if (session.worker !== worker) return;
      session.worker = null;
      if (current !== session) return;
      // Fallen over, with a chunk in its hands: that one goes back first, and it starts again.
      if (session.writing) session.queue.unshift(session.writing);
      session.writing = null;
      session.crashes += 1;
      if (session.crashes > MOST_CRASHES) {
        void end(session, "Perry's ears stopped working, so he stopped listening. What he wrote down so far is kept.");
        return;
      }
      forkWorker(session);
      pump(session);
    });
    session.worker = worker;
  }

  function onWorker(session, message) {
    if (current !== session || session.released) return;
    if (message.type === "progress") {
      session.files.set(message.file, message);
      const all = [...session.files.values()];
      session.progress = all.reduce((sum, file) => sum + file.loaded, 0) / Math.max(1, all.reduce((sum, file) => sum + file.total, 0));
      if (session.progress >= 1) delete session.progress;
      report();
      return;
    }
    const chunk = session.writing;
    session.writing = null;
    if (message.type === "failed") {
      // Not this chunk's fault if it never got a model: then none will work, and it should say so.
      session.failures += 1;
      if (chunk) session.droppedMs += chunk.endMs - chunk.startMs;
      if (session.failures >= 3 && !session.wrote) {
        session.droppedMs += behind(session);
        session.queue.length = 0;
        const worker = session.worker;
        session.worker = null;
        worker?.kill();
        void end(session, `Perry couldn't start writing things down: ${message.error}`);
        return;
      }
    } else {
      session.wrote = true;
      session.spentMs += message.ms;
      session.heardMs += chunk ? chunk.endMs - chunk.startMs : 0;
      if (message.text && chunk) {
        session.unsent.push({ seq: chunk.seq, source: chunk.source, startMs: chunk.startMs, endMs: chunk.endMs, text: message.text });
        if (session.unsent.length > 2_000) void end(session, "Perry's server has been unavailable too long. The saved transcript may contain gaps.");
        void flush(session);
      }
    }
    pump(session);
    settle(session);
  }

  /** The next chunk to the worker, when it has none. */
  function pump(session) {
    if (session.released || session.writing || !session.worker || !session.queue.length) return;
    session.writing = session.queue.shift();
    session.worker.postMessage(session.writing);
  }

  /** Send what is written; `gone` means the owner deleted the meeting while it ran, and that ends it. */
  async function flush(session) {
    if (session.flushing || session.released) return;
    session.flushing = true;
    clearTimeout(session.retry);
    try {
      while (session.unsent.length && !session.released) {
        const batch = session.unsent.slice(0, BATCH);
        const { gone } = await call("meetings:appendSegments", { id: session.id, segments: batch, droppedMs: session.droppedMs });
        session.unsent.splice(0, batch.length);
        if (gone) {
          session.unsent.length = 0;
          session.queue.length = 0;
          session.gone = true;
          if (current === session) void end(session);
          break;
        }
      }
    } catch (error) {
      if (!session.released) session.retry = setTimeout(() => { void flush(session); }, RETRY_MS);
      console.error(`could not send what was said yet: ${error}`);
    } finally {
      session.flushing = false;
    }
    settle(session);
  }

  /** Stopped, and everything heard is written and sent: the meeting is over. */
  function settle(session) {
    if (session.released || session.phase !== "stopping" || session.finishing || !session.pageStopped) return;
    const waiting = session.queue.length || session.writing || session.unsent.length;
    if (waiting && Date.now() - session.stoppedAt < GIVE_UP_MS) return;
    if (waiting) session.endError = "Transcription or saving fell behind. The transcript contains gaps.";
    session.finishing = true;
    void finish(session);
  }

  async function finish(session) {
    const deadline = Date.now() + GIVE_UP_MS;
    while (!session.gone && !session.released) {
      try {
        await call("meetings:finish", { id: session.id, droppedMs: session.droppedMs, ...(session.endError ? { error: session.endError } : {}) });
        break;
      } catch (error) {
        if (Date.now() >= deadline) {
          console.error(`could not close the meeting: ${error}`);
          break;
        }
        await new Promise((resolve) => { session.finishResolve = resolve; session.finishWait = setTimeout(resolve, RETRY_MS); });
      }
    }
    release(session);
    if (current === session) current = null;
    lastError = session.endError ?? null;
    report();
  }

  /** Everything a session holds: the window and with it both ears, the worker, and its timers. */
  function release(session) {
    session.released = true;
    clearInterval(session.alive);
    clearTimeout(session.retry);
    clearTimeout(session.finishWait);
    clearTimeout(session.stopDeadline);
    clearTimeout(session.lastWords);
    session.finishResolve?.();
    session.closedPage?.();
    closeWindow(session);
    const { worker } = session;
    session.worker = null;
    worker?.kill();
    session.queue.length = 0;
    session.unsent.length = 0;
    session.files.clear();
  }

  function closeWindow(session) {
    const win = session.window;
    session.window = null;
    if (win && !win.isDestroyed()) win.destroy();
    if (!current || current === session) sessions.fromPartition("perry-listening").setDisplayMediaRequestHandler(null);
  }

  async function openWindow(session) {
    const partition = "perry-listening";
    const hearing = sessions.fromPartition(partition);
    // The picture Chromium asks for with the sound: the hidden page's own, so the screen is never touched. On a Mac,
    // as Electron's documentation has it, a real screen's source, which is what macOS allows audio capture from.
    hearing.setDisplayMediaRequestHandler(async (request, callback) => {
      if (request.frame !== session.window?.webContents.mainFrame) return callback({});
      if (process.platform !== "darwin") return callback({ video: request.frame, audio: "loopback" });
      const [source] = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } }).catch(() => []);
      callback({ video: source ?? request.frame, audio: "loopback" });
    });
    const win = new BrowserWindow({
      show: false, title: "Perry is listening", skipTaskbar: true,
      webPreferences: {
        preload: join(here, "meeting-preload.cjs"), sandbox: true, contextIsolation: true, partition,
        // Hidden, and heard all the same.
        backgroundThrottling: false, autoplayPolicy: "no-user-gesture-required",
        additionalArguments: [`--perry-loopback=${process.platform === "linux" ? "0" : "1"}`],
      },
    });
    session.window = win;
    win.webContents.on("render-process-gone", () => {
      if (current === session && session.phase === "listening") void end(session, "Perry stopped hearing the call, because the page that listens crashed. What he wrote down so far is kept.");
    });
    await win.loadFile(join(here, "meeting.html"));
    if (current !== session || session.released) throw new Error("Listening was cancelled.");
    // As though from a click: Chromium allows getDisplayMedia only after one.
    return await win.webContents.executeJavaScript("window.perryListen.start()", true);
  }

  const receiveChunk = (event, chunk) => {
    const session = current;
    if (!session || session.released || event.sender !== session.window?.webContents) return;
    session.queue.push(chunk);
    while (behind(session) > MOST_BEHIND_MS) {
      const dropped = session.queue.shift();
      session.droppedMs += dropped.endMs - dropped.startMs;
    }
    pump(session);
  };
  const receiveStatus = (event, status) => {
    const session = current;
    if (!session || event.sender !== session.window?.webContents) return;
    if (status.mic) session.mic = status.mic;
    if (status.system) session.system = status.system;
    if (status.heard) session.heard = { mic: status.heard.mic, system: status.heard.system };
    if ((status.mic || status.system) && session.id) void call("meetings:heard", { id: session.id, mic: session.mic === "live", system: session.system === "live" }).catch(() => {});
    if (session.phase === "listening" && status.runningMs) {
      const lastHeard = Math.max(session.startedAt, session.heard?.mic ?? 0, session.heard?.system ?? 0);
      const quietFor = Date.now() - lastHeard;
      if (session.mic !== "live" && session.system !== "live") void end(session, "Both audio sources disconnected. The transcript so far is kept.");
      else if (status.runningMs >= 4 * 60 * 60_000 || quietFor >= 15 * 60_000 || (otherCall === false && session.hadCall && quietFor >= 2 * 60_000)) void end(session);
    }
    // On the same pipe as the chunks, so after the last of them.
    if (status.closed) session.closedPage?.();
    report();
  };
  ipcMain.on("meeting:chunk", receiveChunk);
  ipcMain.on("meeting:status", receiveStatus);

  /** Close up: stop hearing, then write down what is waiting, then finish. Safe to ask twice. */
  async function end(session, error) {
    if (session.phase === "stopping") return;
    session.phase = "stopping";
    session.stoppedAt = Date.now();
    session.stopDeadline = setTimeout(() => settle(session), GIVE_UP_MS);
    if (error) session.endError = error;
    report();
    clearInterval(session.alive);
    const win = session.window;
    if (win && !win.isDestroyed()) {
      await Promise.race([
        new Promise((resolve) => { session.closedPage = resolve; void win.webContents.executeJavaScript("window.perryListen?.stop()").catch(resolve); }),
        new Promise((resolve) => { session.lastWords = setTimeout(resolve, LAST_WORDS_MS); }),
      ]);
    }
    clearTimeout(session.lastWords);
    if (session.released) return;
    session.pageStopped = true;
    closeWindow(session);
    if (session.worker) pump(session);
    else session.queue.length = 0;
    if (session.crashes > MOST_CRASHES) { session.queue.length = 0; session.writing = null; }
    settle(session);
    void flush(session);
  }

  return {
    state: view,
    /** Start listening, unless already. `ask`: { title?, eventId?, joinUrl?, askedId? }. */
    async start(ask = {}) {
      if (current) return view();
      lastError = null;
      const session = current = {
        phase: "starting", id: null, title: ask.title ?? "Call", startedAt: Date.now(), mic: "off", system: "off",
        worker: null, window: null, queue: [], writing: null, unsent: [], flushing: false, retry: null, alive: null,
        crashes: 0, failures: 0, wrote: false, spentMs: 0, heardMs: 0, droppedMs: 0, files: new Map(), hadCall: otherCall === true,
      };
      report();
      try {
        const meeting = await call("meetings:start", ask);
        if (current !== session || session.released) {
          await call("meetings:abandon", { id: meeting.id }).catch(() => {});
          return view();
        }
        session.id = meeting.id;
        session.title = meeting.title;
        session.startedAt = meeting.startedAt;
        forkWorker(session);
        const status = await openWindow(session);
        if (current !== session || session.released) return view();
        session.mic = status.mic;
        session.system = status.system;
        if (status.mic !== "live" && status.system !== "live") throw new Error(`Perry can't hear anything: the microphone says ${status.mic}, the computer's sound says ${status.system}.`);
        session.phase = "listening";
        await call("meetings:heard", { id: session.id, mic: status.mic === "live", system: status.system === "live" });
        session.alive = setInterval(() => {
          void call("meetings:alive", { id: session.id }).then(({ gone }) => { if (gone) { session.gone = true; void end(session); } }, () => {});
        }, ALIVE_MS);
      } catch (error) {
        const cancelled = session.released;
        release(session);
        if (session.id) await call("meetings:abandon", { id: session.id }).catch(() => {});
        if (current === session) current = null;
        if (!cancelled) lastError = error instanceof Error ? error.message.replace(/^Error invoking remote method.*?: /, "") : String(error);
      }
      report();
      return view();
    },
    /** Stop listening. What was heard is still written down, and then the meeting is written up. */
    async stop() {
      if (current?.phase === "listening") await end(current);
      else if (current?.phase === "starting") {
        const session = current;
        release(session);
        current = null;
        if (session.id) await call("meetings:abandon", { id: session.id }).catch(() => {});
        report();
      }
      return view();
    },
    callActive(active) { otherCall = active; if (current && active) current.hadCall = true; },
    /** How fast Whisper is going, as seconds of writing for each second heard. */
    pace: () => (current?.heardMs ? current.spentMs / current.heardMs : null),
    /** He is quitting: nothing is held up for it; Perry's server finds a meeting that stopped saying it is alive. */
    quit() {
      if (current) release(current);
      current = null;
    },
    dispose() {
      this.quit();
      ipcMain.off("meeting:chunk", receiveChunk);
      ipcMain.off("meeting:status", receiveStatus);
    },
  };
}
