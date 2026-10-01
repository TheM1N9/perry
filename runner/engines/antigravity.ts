import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { ACCESSES } from "../../convex/lib/commands";
import type { EngineStatus, LoginFlow } from "../engine";
import { HOME } from "../home";
import { AcpEngine, modelsOr, type AcpLaunch } from "./acp";

/**
 * Google Antigravity, EXPERIMENTAL: Google's own ACP server
 * (`agy_acp_server`, the ACP registry's `antigravity-acp`), downloaded from
 * dl.google.com only when the owner turns Antigravity on in Settings.
 *
 * Two ways in:
 *   - A Gemini API key (recommended): saved in Settings → Engines and given to
 *     the server as GEMINI_API_KEY in its environment only (`gemini-api-key`).
 *   - Signing in with Google (`oauth-personal`), marked Experimental: the
 *     server opens Google's sign-in page in a browser on this computer and
 *     keeps the sign-in itself. Perry relays nothing and stores nothing.
 *     Google's Antigravity FAQ says using third-party software to access
 *     Antigravity violates its Terms of Service and may be grounds for
 *     suspension; Settings says so before it starts.
 *
 * What is known about the server (from T3 Code's integration) and handled:
 *   - It is a one-file bundle that unpacks about 1 GB into its temp folder on
 *     every start, and a killed one leaves that behind. Its temp folder is
 *     Perry's own (engines/antigravity/tmp), emptied before each start and
 *     when the runner starts, so nothing piles up. It is never started just
 *     to see whether it works, and once started it is kept (15–25 s to start
 *     on Windows).
 *   - Its home (GEMINI_HOME) is Perry's own too, so its sessions and settings
 *     are apart from the owner's Gemini CLI and the agy CLI.
 *   - Modes are a session config option: default (asks) and yolo, which only
 *     a Full access chat gets. It resumes with session/resume, back on its
 *     default model, which is set again. Replies can hang and cancel may do
 *     nothing: the idle watchdog ends it and the session resumes. A reply can
 *     also end (end_turn) before any of it is sent, and arrive after: such a
 *     turn waits for it (lateReplyMs).
 *   - It may not end when its stdin closes, so a server Perry is done with is
 *     ended with its whole process tree: after a stop's grace period, and at
 *     once when the runner stops or crashes (AcpEngine.kill). Its temp folder
 *     is swept then too.
 *   - The download is checked against the size and SHA-256 pinned here for
 *     the version supported (Google publishes none), and unpacked only then.
 *     A partial download or unpack is deleted, whatever went wrong.
 *
 * PERRY_ANTIGRAVITY_RELEASE names a release file to use instead of the pins
 * (tests serve a small fake one).
 */

type Asset = { url: string; sha256: string; size: number; cmd: string; args?: string[] };
type Release = { version: string; assets: Partial<Record<string, Asset>> };

/**
 * agy-acp-server 1.2.1 as the ACP registry lists it. Google publishes no
 * checksums, so these were taken from dl.google.com on 2026-09-27; a file
 * that differs is refused. A new version is a new pin.
 */
const PINNED: Release = {
  version: "1.2.1",
  assets: {
    "windows-x86_64": { url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.2.1-windows-x86_64.zip", sha256: "9b82493819bc14613baa76264d55ad307ddd8ab4a8d6e110edb32da35498c07b", size: 124869770, cmd: "agy_acp_server.exe" },
    "windows-aarch64": { url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.2.1-windows-arm64.zip", sha256: "21db37ae246284053212f2670e05c4de8d6ee9488b000bf304e1fe4ea191f7b8", size: 124945935, cmd: "agy_acp_server.exe" },
    "darwin-aarch64": { url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.2.1-darwin-arm64.zip", sha256: "0fab9938812e6b32b3b543e65e4f3a0025ceef755413db13542d9a9b81ea803c", size: 111725488, cmd: "agy_acp_server.par" },
    "darwin-x86_64": { url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.2.1-darwin-x86_64.zip", sha256: "d09bf99bdea7b82021e1afcff829da35e4aa583d8f0984ef364dc3a7c064e07e", size: 117493869, cmd: "agy_acp_server.par" },
    "linux-x86_64": { url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.2.1-linux-x86_64.zip", sha256: "9fbf0bd584a26478161f637cabd75113f72541c842d148f578ef1a6a9edcb843", size: 333590110, cmd: "agy_acp_server.par", args: ["--uid="] },
    "linux-aarch64": { url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.2.1-linux-arm64.zip", sha256: "7e7ef4088bc185e1af4204029e0f4ec4210af20724f3ff262186ac0bcea6aa0e", size: 321280184, cmd: "agy_acp_server.par", args: ["--uid="] },
  },
};

/** This computer as the registry names platforms. */
const TARGET = `${platform() === "win32" ? "windows" : platform()}-${arch() === "arm64" ? "aarch64" : "x86_64"}`;
const ROOT = join(HOME, "engines", "antigravity");
const DIRS = { server: join(ROOT, "server"), home: join(ROOT, "home"), tmp: join(ROOT, "tmp"), download: join(ROOT, "download") };
const STATE = join(ROOT, "state.json");
type Method = "gemini-api-key" | "oauth-personal";
type State = { method?: Method; google?: boolean };

/** Credentials and settings of the owner's own that must not reach Google's server by accident. */
const STRIPPED = new Set(["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI", "GCLOUD_PROJECT", "CLOUDSDK_CORE_PROJECT", "AGY_ACP_CCPA_PROJECT", "AGY_ACP_ENABLE_OAUTH", "GEMINI_HOME", "ELECTRON_RUN_AS_NODE"]);

const MB = (bytes: number) => Math.round(bytes / 1048576);
/** bsdtar, which reads zips: Windows' own (a GNU tar from Git earlier on PATH does not), and macOS's. */
const TAR = platform() === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
/** Empty a folder of Perry's own, as far as it can; a file still in use stays until next time. */
const sweep = (dir: string) => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 2 }); } catch {} };

export class AntigravityEngine extends AcpEngine {
  private progress: string | null = null;
  private installing: Promise<void> | null = null;

  constructor(warn?: (line: string) => void, private readonly secret: (name: string) => Promise<string | undefined> = async () => process.env.GEMINI_API_KEY) {
    super({
      kind: "antigravity",
      label: "Antigravity",
      capabilities: {
        steer: "queue",
        compaction: { type: "none" },
        approvals: true,
        sandbox: { win32: ACCESSES, darwin: ACCESSES, linux: ACCESSES },
        images: true,
        modelSwitchInSession: true,
        usage: "unavailable",
        quickTurns: false,
      },
      authMethods: [],
      modes: { supervised: ["default"], auto: ["default"], full: ["yolo"] },
      toolsVia: "auto",
      startupMs: 120_000,
      authMs: 300_000,
      idleMs: 3 * 60_000,
      // It can answer end_turn before saying anything, then send the reply.
      lateReplyMs: 30_000,
    }, warn);
    // What a killed server or an interrupted download left behind, from before this runner.
    sweep(DIRS.tmp);
    sweep(DIRS.download);
    try { for (const name of readdirSync(DIRS.server)) if (name.endsWith(".partial")) sweep(join(DIRS.server, name)); } catch {}
  }

  private release(): Release {
    const override = process.env.PERRY_ANTIGRAVITY_RELEASE;
    return override ? JSON.parse(readFileSync(override, "utf8")) as Release : PINNED;
  }

  private state(): State {
    try { return JSON.parse(readFileSync(STATE, "utf8")) as State; } catch { return {}; }
  }

  private save(state: State) {
    mkdirSync(ROOT, { recursive: true });
    writeFileSync(STATE, JSON.stringify(state, null, 2));
  }

  /** Where the verified server is unpacked, when it is. */
  private installed(): { dir: string; asset: Asset; version: string } | null {
    const release = this.release();
    const asset = release.assets[TARGET];
    const dir = join(DIRS.server, release.version);
    return asset && existsSync(join(dir, asset.cmd)) && existsSync(join(dir, ".verified")) ? { dir, asset, version: release.version } : null;
  }

  protected authMethods(): string[] {
    const method = this.state().method;
    return method ? [method] : [];
  }

  protected async launch(): Promise<AcpLaunch> {
    const found = this.installed();
    if (!found) throw new Error("Antigravity is not turned on here yet. Turn it on in Settings → Engines.");
    const state = this.state();
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !STRIPPED.has(name.toUpperCase())) env[name] = value;
    if (state.method === "gemini-api-key") {
      const key = await this.secret("GEMINI_API_KEY");
      if (!key) throw new Error("Antigravity needs your Gemini API key: save it in Settings → Engines.");
      env.GEMINI_API_KEY = key;
    }
    // Its temp folder is emptied before each start: a server that was ended leaves ~1 GB there.
    sweep(DIRS.tmp);
    mkdirSync(DIRS.tmp, { recursive: true });
    mkdirSync(join(DIRS.home, "antigravity-acp"), { recursive: true });
    writeFileSync(join(DIRS.home, "antigravity-acp", "settings.json"), JSON.stringify({ auth: { type: state.method ?? "gemini-api-key" } }));
    const harness = ["localharness_external.exe", "localharness_external"].map((name) => join(found.dir, name)).find((path) => existsSync(path));
    Object.assign(env, { GEMINI_HOME: DIRS.home, TEMP: DIRS.tmp, TMP: DIRS.tmp, TMPDIR: DIRS.tmp, PYTHONUNBUFFERED: "1", ...(harness ? { ANTIGRAVITY_HARNESS_PATH: harness } : {}) });
    return { command: join(found.dir, found.asset.cmd), args: found.asset.args ?? [], env, fullEnv: true, cwd: found.dir };
  }

  /** The server ended, what it unpacked into its temp folder goes too, as far as Windows has let go of it. */
  kill(): void {
    super.kill();
    sweep(DIRS.tmp);
  }

  /** Signing in with Google prints a link among the JSON-RPC lines; it is not relayed, only noted. */
  protected onText(line: string): void {
    if (/authenticate the ACP server/i.test(line)) this.warn("Antigravity opened Google's sign-in page in a browser on this computer.");
  }

  /**
   * Download the pinned server, check its size and SHA-256, and unpack it.
   * Nothing is kept unless all of that worked.
   */
  private install(): Promise<void> {
    this.installing ??= (async () => {
      const release = this.release();
      const asset = release.assets[TARGET];
      if (!asset) throw new Error(`Google's Antigravity server is not made for this computer (${TARGET}).`);
      if (!process.env.PERRY_ANTIGRAVITY_RELEASE && !asset.url.startsWith("https://dl.google.com/")) throw new Error("Antigravity's download must come from dl.google.com.");
      const zip = join(DIRS.download, `${release.version}.zip`);
      const partial = join(DIRS.server, `${release.version}.partial`);
      const target = join(DIRS.server, release.version);
      try {
        mkdirSync(DIRS.download, { recursive: true });
        this.progress = "Downloading Google's Antigravity server…";
        const response = await fetch(asset.url);
        if (!response.ok || !response.body) throw new Error(`The download failed (${response.status}).`);
        const hash = createHash("sha256");
        const declared = Number(response.headers.get("content-length"));
        if (declared && declared !== asset.size) throw new Error(`The download is not the size Perry expects (${declared} bytes), so it was not taken.`);
        const file = createWriteStream(zip);
        let bytes = 0;
        try {
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            hash.update(chunk);
            bytes += chunk.length;
            if (bytes > asset.size) throw new Error("The download is bigger than Perry expects; it was stopped.");
            if (!file.write(chunk)) await new Promise<void>((done) => file.once("drain", () => done()));
            this.progress = `Downloading Google's Antigravity server: ${MB(bytes)} of ${MB(asset.size)} MB.`;
          }
          await new Promise<void>((done, fail) => file.end((error?: Error | null) => error ? fail(error) : done()));
        } catch (error) {
          // Closed first: Windows will not delete a file still open.
          await new Promise<void>((done) => { file.once("close", () => done()); file.destroy(); });
          throw error;
        }
        const sha256 = hash.digest("hex");
        if (bytes !== asset.size || sha256 !== asset.sha256.toLowerCase()) {
          throw new Error(`The download does not match the Antigravity ${release.version} Perry knows (${bytes} bytes, SHA-256 ${sha256.slice(0, 12)}…), so it was deleted and not run.`);
        }
        this.progress = "Unpacking Google's Antigravity server…";
        sweep(partial);
        mkdirSync(partial, { recursive: true });
        const unzip = platform() === "linux"
          ? spawnSync("unzip", ["-q", "-o", zip, "-d", partial], { stdio: "pipe", windowsHide: true })
          : spawnSync(TAR, ["-xf", zip, "-C", partial], { stdio: "pipe", windowsHide: true });
        if (unzip.status !== 0) throw new Error(`Could not unpack Antigravity: ${String(unzip.stderr ?? unzip.error ?? "").trim().slice(0, 200)}`);
        if (!existsSync(join(partial, asset.cmd))) throw new Error(`Antigravity's download has no ${asset.cmd}.`);
        if (platform() !== "win32") chmodSync(join(partial, asset.cmd), 0o755);
        writeFileSync(join(partial, ".verified"), JSON.stringify({ version: release.version, sha256, size: bytes, at: new Date().toISOString() }));
        sweep(target);
        renameSync(partial, target);
        // Older versions go once this one is in place.
        for (const name of readdirSync(DIRS.server)) if (name !== release.version) sweep(join(DIRS.server, name));
      } finally {
        this.progress = null;
        sweep(DIRS.download);
        sweep(partial);
      }
    })().finally(() => { this.installing = null; });
    return this.installing;
  }

  async status(): Promise<EngineStatus> {
    const found = this.installed();
    const state = this.state();
    const base = { kind: "antigravity" as const, installed: true, auth: {}, models: [] };
    if (!found) {
      return { ...base, signedIn: false, message: this.progress ?? `Experimental. Not turned on: turning it on downloads Google's own Antigravity ACP server (about ${MB(this.release().assets[TARGET]?.size ?? 0) || 125} MB, about 1 GB unpacked) into Perry's folder.` };
    }
    const key = state.method === "gemini-api-key" ? await this.secret("GEMINI_API_KEY").catch(() => undefined) : undefined;
    const signedIn = state.method === "gemini-api-key" ? Boolean(key) : state.method === "oauth-personal" && Boolean(state.google);
    return {
      ...base,
      version: found.version,
      signedIn,
      auth: signedIn ? (state.method === "gemini-api-key" ? { type: "gemini-api-key", label: "Gemini API key" } : { type: "oauth-personal", label: "Google account (experimental)" }) : {},
      models: signedIn ? modelsOr(this.learnedModels(), this.label) : [],
      message: this.progress ?? (signedIn ? "Experimental." : state.method === "gemini-api-key" ? "Save your Gemini API key in Settings → Engines." : "Experimental. Use a Gemini API key (recommended), or sign in with Google."),
    };
  }

  /**
   * Turn Antigravity on: the download (once), then the way in the owner
   * picked: the Gemini API key from Settings → Engines (the default), or
   * signing in with Google in a browser on this computer.
   */
  async login(method?: string): Promise<LoginFlow> {
    const way: Method = method === "oauth-personal" ? "oauth-personal" : "gemini-api-key";
    if (way === "gemini-api-key" && !await this.secret("GEMINI_API_KEY")) {
      throw new Error("Save your Gemini API key in Settings → Engines first (from aistudio.google.com/apikey), then try again");
    }
    const downloading = !this.installed();
    const before = this.state();
    const done = (async () => {
      // Only when it is not there yet: unpacking over the folder a server runs from fails on Windows, part-deleted.
      if (downloading) await this.install();
      this.kill();
      this.save({ ...before, method: way });
      try {
        // Starting it signs it in: with the key, or by Google's page in a browser here.
        await this.ensure();
        this.save({ ...this.state(), method: way, ...(way === "oauth-personal" ? { google: true } : {}) });
      } catch (error) {
        this.kill();
        this.save(before);
        throw error;
      }
    })();
    const steps = [
      ...(downloading ? [`Perry is downloading Google's Antigravity server (about ${MB(this.release().assets[TARGET]?.size ?? 0)} MB), checking it, and unpacking it.`] : []),
      way === "oauth-personal" ? "Google's sign-in page then opens in a browser on this computer: sign in there." : "It then checks your Gemini API key.",
      "This page updates by itself.",
    ];
    return { interaction: { type: "credentials", message: steps.join(" ") }, done, cancel: () => this.kill() };
  }

  async logout(): Promise<void> {
    const state = this.state();
    if (state.method === "oauth-personal" && this.installed()) {
      const conn = await this.ensure().catch(() => null);
      if (conn?.init.agentCapabilities?.auth?.logout) await conn.agent.request("logout", {}).catch(() => {});
    }
    this.kill();
    this.save({});
  }
}

/** The pinned asset for this computer, for checks. */
export const pinnedAsset = () => PINNED.assets[TARGET];
export const antigravityDirs = DIRS;

