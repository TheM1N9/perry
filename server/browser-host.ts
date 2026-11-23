import { z } from "zod";
import * as browser from "../convex/lib/browser";
import type { BrowserRequest, BrowserState } from "../lib/browser-protocol";
import { nativeBrowserAvailable } from "./browser-runtime";

export async function browserStatus(scope: string, importEnabled: boolean): Promise<BrowserState> {
  return browser.withBrowserView(scope, () => statusInScope(scope, importEnabled));
}
async function statusInScope(scope: string, importEnabled: boolean): Promise<BrowserState> {
  const state = browser.browserControl(scope);
  const result: BrowserState = { importEnabled, source: state.source, nativeWindow: state.nativeWindow ?? process.env.PERRY_BROWSER_HEADED === "1", state: state.error ? "disconnected" : "closed", identity: browser.identity(scope), viewport: browser.browserViewport(), canGoBack: false, canGoForward: false, tabs: [], loading: state.loading, error: state.error, dialog: state.dialog, upload: state.upload !== null, private: state.private, downloads: [...state.downloads.values()].slice(-30) };
  if (!state.current) return result;
  try {
    result.tabs = (await browser.withBrowserView(scope, browser.hostTargets)).map(({ id, title, url }) => ({ id, title, url }));
    if (!result.tabs.some((item) => item.id === result.identity?.tabId)) {
      state.epoch++; state.revision++; state.controller = "owner";
      if (result.tabs[0]) await browser.withBrowserView(scope, () => browser.selectHostTab(result.tabs[0].id));
      else { await browser.withBrowserView(scope, async () => browser.closeBrowser()); return { ...result, identity: null, state: "closed" }; }
    }
    // Page metadata can be temporarily unavailable during a renderer swap.
    // A successful target listing still means the browser is connected.
    if (!state.dialog) {
      try {
        if (result.nativeWindow) {
          const { cssLayoutViewport: size } = z.object({ cssLayoutViewport: z.object({ clientWidth: z.number(), clientHeight: z.number() }) }).parse(await browser.hostCommand("Page.getLayoutMetrics"));
          if (size.clientWidth > 0 && size.clientHeight > 0 && (size.clientWidth !== result.viewport.width || size.clientHeight !== result.viewport.height)) {
            state.viewport = { width: size.clientWidth, height: size.clientHeight };
            state.revision++;
            result.viewport = state.viewport;
          }
        }
        const history = z.object({ currentIndex: z.number(), entries: z.array(z.unknown()) }).parse(await browser.hostCommand("Page.getNavigationHistory"));
        result.canGoBack = history.currentIndex > 0;
        result.canGoForward = history.currentIndex < history.entries.length - 1;
      } catch {
        if (!state.current || state.current.ws.readyState !== WebSocket.OPEN) throw new Error("The browser connection closed.");
      }
    }
    result.identity = browser.identity(scope);
    result.state = state.controller === "owner" ? "paused" : "live";
    return result;
  } catch {
    state.error = "Browser connection lost. Reopen the browser; previous tabs may be lost.";
    return { ...result, state: "disconnected", identity: null, tabs: [], loading: false, error: state.error };
  }
}
export async function controlBrowser(scope: string, request: BrowserRequest, importEnabled: boolean) {
  return browser.withBrowserView(scope, () => controlInScope(scope, request, importEnabled));
}
async function controlInScope(scope: string, request: BrowserRequest, importEnabled: boolean) {
  const state = browser.browserControl(scope);
  if (request.action === "status") return browserStatus(scope, importEnabled);
  if (state.ownerBusy && request.action !== "frame") throw new Error("Another browser action is still running. Wait for it to finish.");
  if (request.action === "connectChrome") {
    throw new Error("The browser now uses Perry's own profile. Use Import from browser to migrate your data.");
  }
  if (request.action === "nativeProfiles") {
    if (!importEnabled) throw new Error("Open Perry locally to import browser data.");
    return (await import("./browser-import")).nativeProfiles();
  }
  if (request.action === "nativeImport") {
    if (!importEnabled) throw new Error("Open Perry locally to import browser data.");
    const imported = await (await import("./browser-import")).nativeImport(scope, request.identity, request.profileId, request.choices);
    return { imported, state: await browserStatus(scope, importEnabled) };
  }
  if (request.action === "start") {
    if (request.nativeWindow && !importEnabled) throw new Error("Open Perry locally to open a desktop browser window.");
    if (request.nativeWindow && !nativeBrowserAvailable()) throw new Error("The browser desktop window is unavailable on this host. Open it in the panel instead.");
    if (state.error && state.current) await browser.withBrowserView(scope, async () => browser.closeBrowser());
    if (state.current && request.nativeWindow !== undefined && request.nativeWindow !== state.nativeWindow) throw new Error("The browser is already open. Close it before changing window mode.");
    if (!state.current) state.nativeWindow = request.nativeWindow ?? (process.env.PERRY_BROWSER_HEADED === "1" || (process.env.PERRY_BROWSER_HEADED !== "0" && importEnabled && nativeBrowserAvailable()));
    state.controller = "owner"; state.private = true; state.epoch++; state.revision++; browser.saveBrowserControl(scope);
    await browser.withOwnerBrowser(scope, async () => { await browser.hostTargets(); });
    return browserStatus(scope, importEnabled);
  }
  if (request.action === "takeover") {
    state.controller = "owner"; state.private = true; state.epoch++; state.revision++; browser.saveBrowserControl(scope);
    if (state.current) void browser.withBrowserView(scope, async () => { await browser.hostCommand("Page.stopLoading"); }).catch(() => {});
    return browserStatus(scope, importEnabled);
  }
  if (request.action === "profiles") {
    if (!importEnabled) throw new Error("Session import is disabled or unavailable over this connection. Open Perry locally or sign in manually.");
    return (await import("./browser-sessions")).discoverProfiles();
  }
  if (request.action === "previewImport") {
    if (!importEnabled || state.controller !== "owner") throw new Error("Take over the browser on this computer before importing sessions.");
    return browser.withOwnerBrowser(scope, async () => (await import("./browser-sessions")).previewImport(scope, request.profileId));
  }
  browser.checkIdentity(request.identity, scope);
  if (request.action === "frame") {
    return browser.withBrowserView(scope, async () => {
      const shot = z.object({ data: z.string() }).parse(await browser.hostCommand("Page.captureScreenshot", { format: "jpeg", quality: 65, optimizeForSpeed: true, captureBeyondViewport: false }));
      browser.checkIdentity(request.identity, scope);
      return { image: shot.data, identity: browser.identity(scope), capturedAt: Date.now() };
    });
  }
  if (request.action === "resume") {
    if (state.error) throw new Error("The browser needs recovery. Reopen it before resuming.");
    if (state.busy) throw new Error("The cancelled agent action is still finishing. Wait, then explicitly resume again.");
    await browser.releaseOwnerInput();
    state.controller = "agent"; state.epoch++; state.revision++; browser.saveBrowserControl(scope);
    return browserStatus(scope, importEnabled);
  }
  if (state.controller !== "owner") throw new Error("Pause and take over before interacting with the browser.");
  return browser.withOwnerBrowser(scope, async () => {
    switch (request.action) {
      case "close": browser.closeBrowser(); break;
      case "navigate": {
        if (!/^https?:\/\//i.test(request.url)) throw new Error("The browser opens http and https addresses only.");
        const navigation = z.object({ errorText: z.string().optional() }).parse(await browser.hostCommand("Page.navigate", { url: request.url }));
        if (navigation.errorText) throw new Error(`Navigation failed (${navigation.errorText}).`);
        break;
      }
      case "back":
      case "forward": {
        const history = z.object({ currentIndex: z.number(), entries: z.array(z.object({ id: z.number() })) }).parse(await browser.hostCommand("Page.getNavigationHistory"));
        const entry = history.entries[history.currentIndex + (request.action === "back" ? -1 : 1)];
        if (entry) await browser.hostCommand("Page.navigateToHistoryEntry", { entryId: entry.id });
        break;
      }
      case "stop": await browser.hostCommand("Page.stopLoading"); break;
      case "viewport": await browser.resizeBrowser(request.width, request.height); break;
      case "input": {
        const input = request.input;
        if ("x" in input) {
          const viewport = browser.browserViewport();
          if (input.x > viewport.width || input.y > viewport.height) throw new Error("The browser page changed. Look again before acting.");
        }
        if (input.type === "pointer") {
          state.ownerPointer = input.buttons ? { tabId: request.identity.tabId, x: input.x, y: input.y, buttons: input.buttons } : undefined;
          const { type: _, phase, ...params } = input;
          await browser.hostCommand("Input.dispatchMouseEvent", { type: phase, ...params });
        } else if (input.type === "wheel") {
          const { type: _, ...params } = input;
          await browser.hostCommand("Input.dispatchMouseEvent", { type: "mouseWheel", ...params });
        } else if (input.type === "text") await browser.hostCommand("Input.insertText", { text: input.text });
        else {
          for (const type of ["keyDown", "keyUp"]) await browser.hostCommand("Input.dispatchKeyEvent", { type, key: input.key, code: input.code, modifiers: input.modifiers, windowsVirtualKeyCode: input.keyCode, ...(input.key === "Enter" && type === "keyDown" ? { text: "\r" } : {}) });
        }
        // Input is frequent. State and frames already have their own stream.
        return { identity: browser.identity(scope) };
      }
      case "reload": await browser.hostCommand("Page.reload"); break;
      case "tab": await browser.releaseOwnerInput(); await browser.selectHostTab(request.tabId); state.revision++; break;
      case "newTab": {
        const target = z.object({ targetId: z.string() }).parse(await browser.hostCommand("Target.createTarget", { url: "about:blank" }));
        await browser.selectHostTab(target.targetId); state.revision++; break;
      }
      case "closeTab": {
        await browser.hostCommand("Target.closeTarget", { targetId: request.identity.tabId }); state.revision++; break;
      }
      case "click":
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await browser.hostCommand("Input.dispatchMouseEvent", { type, x: request.x, y: request.y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1 });
        break;
      case "scroll": await browser.hostCommand("Input.dispatchMouseEvent", { type: "mouseWheel", x: request.x, y: request.y, deltaX: 0, deltaY: request.deltaY }); break;
      case "text": await browser.hostCommand("Input.insertText", { text: request.text }); break;
      case "key":
        for (const type of ["keyDown", "keyUp"]) await browser.hostCommand("Input.dispatchKeyEvent", { type, key: request.key, code: request.code, modifiers: request.modifiers, ...(request.keyCode !== undefined ? { windowsVirtualKeyCode: request.keyCode } : {}), ...(request.key === "Enter" && type === "keyDown" ? { text: "\r", windowsVirtualKeyCode: 13 } : {}), ...(request.key === "Backspace" ? { windowsVirtualKeyCode: 8 } : {}), ...(request.key === "Tab" ? { windowsVirtualKeyCode: 9 } : {}) });
        break;
      case "dialog": await browser.hostCommand("Page.handleJavaScriptDialog", { accept: request.accept, promptText: request.text }); state.dialog = null; break;
      case "privacy": state.private = request.private; browser.saveBrowserControl(scope); break;
      case "import":
        if (state.source === "chrome") throw new Error("Use Perry's browser for Firefox imports.");
        if (!importEnabled) throw new Error("Session import is disabled on this connection.");
        return (await import("./browser-sessions")).importSessions(scope, request.identity, request.ticket, request.sites);
      case "sessions": return (await import("./browser-sessions")).listSessions(scope);
      case "removeSession": return (await import("./browser-sessions")).removeSession(scope, request.site);
    }
    return browserStatus(scope, importEnabled);
  });
}
