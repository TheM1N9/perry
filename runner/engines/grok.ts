import { ACCESSES } from "../../convex/lib/commands";
import type { EngineModel, EngineStatus, LoginFlow } from "../engine";
import { AcpEngine, modelsOr, waitForSignIn, type AcpLaunch } from "./acp";
import { updateCommand } from "../versions";
import { commandOf, killTree, runCli, spawnEngine } from "./process";

/**
 * Grok Build, xAI's coding agent CLI, over ACP (`grok agent stdio`), signed
 * in with the owner's own Grok account (`grok login`) or an XAI_API_KEY. Its
 * source is public (github.com/xai-org/grok-build); what is relied on here:
 *
 *   - `grok --version` and `grok models`, whose first line says whether it is
 *     signed in, are the status: no agent is started to find out.
 *   - `grok login --device-auth` prints a link and a code and waits; Perry
 *     shows them in Settings. Grok's CLI keeps the sign-in (~/.grok), which
 *     Perry never reads.
 *   - The agent offers `cached_token` (the CLI's sign-in) and `xai.api_key`
 *     only when they would work, so authenticating never opens a browser.
 *   - It has no session modes. It asks before edits, commands that are not
 *     read-only, fetches and MCP calls unless always-approve is on, which
 *     `--permission-mode default` keeps off whatever the owner's Grok config
 *     says, since a chat's access can change between turns while its
 *     session stays. At Full access Perry answers each request "allow once".
 *     (Two other ACP clients reported older Grok versions never asking; if
 *     that returns, Ask would not hold on Grok, so check with a real run.)
 *   - Model and reasoning effort are session config options (`model`,
 *     `reasoning_effort`); `grok models` lists the models.
 *   - A second session/prompt while one runs is queued behind it, so a
 *     message sent mid-reply is answered in the same reply.
 *   - `/compact` is taken as a prompt. Usage comes in the prompt answer's _meta.
 *   - Perry's tools go over HTTP with the runner's bearer header, which Grok
 *     honours; its MCP tools are named `assistant__<tool>`.
 *   - It has a sandbox only on macOS and Linux, and off unless asked for;
 *     Perry does not turn it on, so Ask and Auto rest on approvals alone.
 *
 * PERRY_GROK_COMMAND names another command for `grok` (tests point it at a
 * stand-in agent).
 */

/** Grok's sign-in names Perry as the app asking. */
const ENV = { GROK_OAUTH2_REFERRER: "perry" };
/** The efforts Grok offers a model that names none of its own (xai-grok-shell's session_config.rs). */
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
const INSTALL ="Install Grok Build on this computer (npm install -g @xai-official/grok), then sign in here.";

/** What `grok models` says: whether and how it is signed in, and the models. */
export function parseModels(output: string): { signedIn: boolean; label?: string; models: EngineModel[] } {
  const first = output.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  const label = /logged in with/i.test(first) ? "Grok account"
    : /XAI_API_KEY/.test(first) ? "xAI API key"
    : /deployment key/i.test(first) ? "Deployment key"
    : /own API key/i.test(first) ? "API key"
    : undefined;
  const listed = output.slice(Math.max(0, output.indexOf("Available models:")));
  const models = [...listed.matchAll(/^\s*[*-]\s+(\S+)(\s+\(default\))?/gm)].map((match): EngineModel => ({ id: match[1], name: match[1], isDefault: Boolean(match[2]) }));
  return { signedIn: Boolean(label) && !/not authenticated/i.test(first), label, models };
}

export class GrokEngine extends AcpEngine {
  private readonly cli = commandOf("PERRY_GROK_COMMAND", "grok");
  /** `grok models` asks xAI; a probe every half minute reuses its answer for a while. */
  private listed: { at: number; result: ReturnType<typeof parseModels> } | null = null;

  constructor(warn?: (line: string) => void) {
    super({
      kind: "grok",
      label: "Grok Build",
      capabilities: {
        steer: "concurrent-prompt",
        compaction: { type: "slash-command", command: "/compact" },
        approvals: true,
        // By approvals alone: Grok's own sandbox is off (and on Windows there is none).
        sandbox: { win32: ACCESSES, darwin: ACCESSES, linux: ACCESSES },
        // Grok does not say it takes images, so attachments go as paths it can read.
        images: false,
        modelSwitchInSession: true,
        usage: "partial",
        quickTurns: false,
      },
      authMethods: ["cached_token", "xai.api_key"],
      modes: { supervised: [], auto: [], full: [] },
      toolsVia: "auto",
      sessionMeta: { yoloMode: false, autoMode: false },
    }, warn);
  }

  protected launch(): AcpLaunch {
    // --no-leader: this process, not one shared through Grok's leader, so stopping it stops the turn.
    return { command: this.cli.command, args: [...this.cli.args, "--permission-mode", "default", "agent", "--no-leader", "stdio"], env: ENV };
  }

  async status(): Promise<EngineStatus> {
    const base: Pick<EngineStatus, "kind" | "auth" | "models" | "update"> = { kind: "grok", auth: {}, models: [] };
    let version: string | undefined;
    try {
      const ran = await runCli(this.cli, ["--version"]);
      if (ran.code !== 0) return { ...base, installed: false, signedIn: false, message: INSTALL, error: ran.stderr.trim().split("\n")[0] || undefined };
      version = ran.stdout.match(/grok\s+(\S+)/i)?.[1] ?? ran.stdout.trim().split("\n")[0];
    } catch (error) {
      return { ...base, installed: false, signedIn: false, message: INSTALL, error: error instanceof Error ? error.message : String(error) };
    }
    // Updated the way this grok was installed: `grok update`, or npm's command for an npm install.
    base.update = updateCommand("grok", this.cli.command);
    try {
      if (!this.listed || Date.now() - this.listed.at > 2 * 60_000) {
        const ran = await runCli(this.cli, ["models"], 30_000, { ...process.env, ...ENV });
        this.listed = { at: Date.now(), result: parseModels(`${ran.stdout}\n${ran.stderr}`) };
      }
      const { signedIn, label, models } = this.listed.result;
      // Efforts are per model, and only a session says which: those seen are used, else
      // Grok's own fallback list. A model without the one picked keeps its own.
      const learned = new Map(this.learnedModels().map((model) => [model.id, model]));
      const merged = models.map((model) => {
        const seen = learned.get(model.id);
        return { ...model, efforts: seen?.efforts ?? EFFORTS, ...(seen?.defaultEffort ? { defaultEffort: seen.defaultEffort } : {}) };
      });
      return {
        ...base, installed: true, version, signedIn,
        auth: signedIn ? { type: label === "Grok account" ? "grok" : "api-key", label } : {},
        models: signedIn ? modelsOr(merged.length ? merged : this.learnedModels(), this.label) : [],
        message: !signedIn ? "Sign in with your Grok account, or run `grok login` on this computer."
          : process.platform === "win32" ? "Grok has no sandbox on Windows: on Ask, each command and edit waits for your approval." : undefined,
      };
    } catch (error) {
      return { ...base, installed: true, version, signedIn: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Grok's device code: `grok login --device-auth` prints a link and a code,
   * which Settings shows, and finishes once the owner has confirmed it. Where
   * it has none (a company's single sign-on), the owner runs `grok login` here.
   */
  async login(): Promise<LoginFlow> {
    this.listed = null;
    if ((await this.status()).signedIn) return { interaction: null, done: Promise.resolve(), cancel: () => {} };
    const child = spawnEngine(this.cli.command, [...this.cli.args, "login", "--device-auth"], { ...process.env, ...ENV });
    let printed = "";
    const exited = new Promise<number | null>((done) => { child.on("close", done); child.on("error", () => done(-1)); });
    const code = await new Promise<{ verificationUrl: string; userCode: string } | null>((done) => {
      const timer = setTimeout(() => done(null), 30_000);
      const read = (chunk: Buffer) => {
        printed += chunk;
        const url = printed.match(/https?:\/\/\S+/)?.[0];
        const userCode = printed.match(/(?:code in your browser|enter this code):?\s*\n\s*(\S+)/i)?.[1];
        if (url && userCode) { clearTimeout(timer); done({ verificationUrl: url, userCode }); }
      };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
      void exited.then(() => { clearTimeout(timer); done(null); });
    });
    const finish = (signedIn: Promise<void>) => signedIn.finally(() => { this.listed = null; this.kill(); });
    if (code) {
      return {
        interaction: { type: "deviceCode", ...code },
        done: finish(exited.then((status) => { if (status !== 0) throw new Error(printed.trim().split("\n").at(-1) || "Grok's sign-in did not finish."); })),
        cancel: () => killTree(child, "SIGKILL"),
      };
    }
    killTree(child, "SIGKILL");
    const waiting = waitForSignIn(async () => { this.listed = null; return (await this.status()).signedIn; }, "Signing in to Grok");
    return { interaction: { type: "terminal", command: "grok login" }, done: finish(waiting.done), cancel: waiting.cancel };
  }

  async logout(): Promise<void> {
    const ran = await runCli(this.cli, ["logout"], 30_000, { ...process.env, ...ENV });
    this.listed = null;
    // The running agent still holds the old sign-in.
    this.kill();
    if (ran.code !== 0) throw new Error(ran.stderr.trim() || "grok logout failed.");
  }
}
