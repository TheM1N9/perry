import { z } from "zod";
import * as browser from "../convex/lib/browser";
import type { BrowserRequest, BrowserState } from "../lib/browser-protocol";

export async function browserStatus(scope: string, importEnabled: boolean): Promise<BrowserState> {
  const state = browser.browserControl(scope);
  const result: BrowserState = { enabled: process.env.PERRY_BROWSER_VIEW === "1", importEnabled, source: state.source, state: state.error ? "disconnected" : "closed", identity: browser.identity(scope), tabs: [], loading: state.loading, error: state.error, dialog: state.dialog, upload: state.upload !== null, private: state.private, downloads: [...state.downloads.values()].slice(-30) };
  if (!state.current) return result;
  try {
    result.tabs = (await browser.withBrowserView(scope, browser.hostTargets)).map(({ id, title, url }) => ({ id, title, url }));
    if (!result.tabs.some((item) => item.id === result.identity?.tabId)) {
      state.epoch++; state.revision++; state.controller = "owner";
      if (result.tabs[0]) await browser.withBrowserView(scope, () => browser.selectHostTab(result.tabs[0].id));
      else { await browser.withBrowserView(scope, async () => browser.closeBrowser()); return { ...result, identity: null, state: "closed" }; }
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
    if (state.error && state.current) await browser.withBrowserView(scope, async () => browser.closeBrowser());
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
    if (state.busy) throw new Error("The cancelled agent action is still finishing. Wait, then explicitly resume again.");
    state.controller = "agent"; state.epoch++; state.revision++; browser.saveBrowserControl(scope);
    return browserStatus(scope, importEnabled);
  }
  if (state.controller !== "owner") throw new Error("Pause and take over before interacting with the browser.");
  return browser.withOwnerBrowser(scope, async () => {
    switch (request.action) {
      case "close": browser.closeBrowser(); break;
      case "navigate": await browser.open(request.url); break;
      case "back": await browser.hostCommand("Runtime.evaluate", { expression: "history.back()" }); break;
      case "reload": await browser.hostCommand("Page.reload"); break;
      case "tab": await browser.selectHostTab(request.tabId); state.revision++; break;
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
        for (const type of ["keyDown", "keyUp"]) await browser.hostCommand("Input.dispatchKeyEvent", { type, key: request.key, code: request.code, modifiers: request.modifiers, ...(request.key === "Enter" && type === "keyDown" ? { text: "\r", windowsVirtualKeyCode: 13 } : {}), ...(request.key === "Backspace" ? { windowsVirtualKeyCode: 8 } : {}), ...(request.key === "Tab" ? { windowsVirtualKeyCode: 9 } : {}) });
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
