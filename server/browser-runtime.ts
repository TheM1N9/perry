import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Browser, BrowserTag, detectBrowserPlatform, getInstalledBrowsers, install, resolveBuildId } from "@puppeteer/browsers";
import { HOME } from "../runner/home";

const cacheDir = join(HOME, "browser", "runtime");
let installing: Promise<string> | undefined;
/** Dedicated engine and profile: never falls back to an owner's personal browser. */
export async function browserExecutable() {
  if (process.env.PERRY_BROWSER_PATH) {
    if (!existsSync(process.env.PERRY_BROWSER_PATH)) throw new Error("The browser engine is unavailable. Check PERRY_BROWSER_PATH.");
    return process.env.PERRY_BROWSER_PATH;
  }
  installing ??= (async () => {
    const installed = (await getInstalledBrowsers({ cacheDir })).filter(item => item.browser === Browser.CHROME && existsSync(item.executablePath)).sort((a, b) => b.buildId.localeCompare(a.buildId, undefined, { numeric: true }));
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const platform = detectBrowserPlatform();
    if (!platform) throw new Error("The browser engine isn't available for this platform.");
    try {
      const buildId = await resolveBuildId(Browser.CHROME, platform, BrowserTag.STABLE);
      return installed.find(browser => browser.buildId === buildId)?.executablePath ?? (await install({ browser: Browser.CHROME, cacheDir, buildId, platform })).executablePath;
    } catch {
      if (installed.length) return installed[0].executablePath;
      throw new Error("The browser engine couldn't be downloaded. Check the connection and retry.");
    }
  })().catch(error => { installing = undefined; throw error; });
  return installing;
}
