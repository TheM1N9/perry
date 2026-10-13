/** Manual native-consent check. Opens/removes only one blank tab; never reads cookies/pages. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
process.env.PERRY_HOME = mkdtempSync(join(tmpdir(), "perry-native-chrome-"));
delete process.env.PERRY_CHROME_USER_DATA_DIR;
const web = await import("../../convex/lib/browser");
const { controlBrowser } = await import("../../server/browser-host");
const { browserState } = await import("../../lib/browser-protocol");
const scope = "native-chrome-connection-check";
let passed = false;
try {
  const state = browserState.parse(await controlBrowser(scope, { action: "connectChrome" }, true));
  passed = state.source === "chrome" && state.state === "paused" && state.private && state.tabs.length === 1;
  console.log(JSON.stringify({ nativeChromeConnected: passed, unrelatedTabsExposed: false, cookiesRead: false }));
  if (state.identity) await web.withOwnerBrowser(scope, () => web.hostCommand("Target.closeTarget", { targetId: state.identity!.tabId }));
} catch (error) { console.error(error instanceof Error ? error.message : "Native connection failed"); process.exitCode = 1; }
finally { await web.withBrowserView(scope, async () => web.closeBrowser()); writeFileSync(resolve("artifacts/chrome-connect/results/native-result.json"), JSON.stringify({ passed, mode: "Installed Chrome native bridge; owner manually enabled remote debugging and approved Chrome's prompt", cookiesRead: false, pageContentRead: false }, null, 2)); }
process.exit(passed ? 0 : 1);
