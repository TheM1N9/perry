import { ACCESSES } from "../../convex/lib/commands";
import type { EngineModel, EngineStatus, LoginFlow } from "../engine";
import { AcpEngine, modelsOr, waitForSignIn, type AcpLaunch } from "./acp";
import { updateCommand } from "../versions";
import { commandOf, runCli } from "./process";

/**
 * OpenCode, an open-source coding agent, over ACP (`opencode acp`), signed in
 * with the owner's own providers (`opencode auth login`). Free models work
 * without an account; paid ones need a login, which Perry leaves to OpenCode's
 * own command.
 *
 * PERRY_OPENCODE_COMMAND names another command for `opencode` (tests point it
 * at a stand-in agent).
 */

const INSTALL = "Install OpenCode on this computer (see https://opencode.ai), then sign in here if you want a paid model.";

/**
 * The efforts OpenCode's models take, until a session has said which the
 * chosen model really offers: only ACP knows them per model (see status), as
 * Grok's do. A model without the one picked is left to its own default.
 */
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Parse `opencode models`: one model id per line, named by its last segment. What each takes comes from ACP. */
export function parseModels(output: string): EngineModel[] {
  const ids = output.split("\n").map((line) => line.trim()).filter(Boolean);
  return ids.map((id, index): EngineModel => ({ id, name: id.split("/").pop() || id, isDefault: index === 0 }));
}

export class OpenCodeEngine extends AcpEngine {
  private readonly cli = commandOf("PERRY_OPENCODE_COMMAND", "opencode");
  private listed: { at: number; models: EngineModel[] } | null = null;

  constructor(warn?: (line: string) => void) {
    super({
      kind: "opencode",
      label: "OpenCode",
      capabilities: {
        steer: "queue",
        compaction: { type: "slash-command", command: "/compact" },
        approvals: true,
        sandbox: { win32: ACCESSES, darwin: ACCESSES, linux: ACCESSES },
        images: true,
        modelSwitchInSession: true,
        usage: "partial",
        quickTurns: false,
      },
      authMethods: ["opencode-login"],
      modes: { supervised: [], auto: [], full: [] },
      toolsVia: "auto",
    }, warn);
  }

  protected launch(): AcpLaunch {
    return { command: this.cli.command, args: [...this.cli.args, "acp"] };
  }

  where(): string | undefined {
    return this.cli.args.length ? undefined : this.cli.command;
  }

  reload(): void {
    this.kill();
    this.listed = null;
  }

  /** Whether a provider account or key is connected, as `opencode auth list` says. The free models need none. */
  private async authenticated(): Promise<boolean> {
    try {
      const ran = await runCli(this.cli, ["auth", "list", "--format", "json"], 20_000);
      if (ran.code !== 0) return false;
      const found: unknown = JSON.parse(ran.stdout);
      return Array.isArray(found) && found.some((item: { connections?: unknown[] }) => (item?.connections?.length ?? 0) > 0);
    } catch {
      return false;
    }
  }

  async status(): Promise<EngineStatus> {
    const base: Pick<EngineStatus, "kind" | "auth" | "models" | "update"> = { kind: "opencode", auth: {}, models: [] };
    let version: string | undefined;
    try {
      const ran = await runCli(this.cli, ["--version"]);
      if (ran.code !== 0) return { ...base, installed: false, signedIn: false, message: INSTALL, error: ran.stderr.trim().split("\n")[0] || undefined };
      version = ran.stdout.trim().split("\n")[0];
    } catch (error) {
      return { ...base, installed: false, signedIn: false, message: INSTALL, error: error instanceof Error ? error.message : String(error) };
    }
    base.update = updateCommand("opencode", this.cli.command);
    try {
      let listError: string | undefined;
      if (!this.listed || Date.now() - this.listed.at > 2 * 60_000) {
        const ran = await runCli(this.cli, ["models"], 30_000);
        // Only a successful listing says anything about models: a failed one
        // must not turn OpenCode's error text into a model id.
        if (ran.code === 0) this.listed = { at: Date.now(), models: parseModels(ran.stdout) };
        else {
          this.listed = { at: Date.now(), models: [] };
          listError = ran.stderr.trim().split("\n")[0] || `opencode models exited with code ${ran.code}`;
        }
      }
      // Efforts are per model, and only a session says which: those ACP has
      // seen are used, else OpenCode's fallback list. ACP names its own
      // default "default", which the picker already offers as "Default".
      const learned = new Map(this.learnedModels().map((model) => [model.id, model]));
      const models = (this.listed.models.length ? this.listed.models : this.learnedModels()).map((model) => {
        const seen = learned.get(model.id);
        const efforts = (seen?.efforts ?? EFFORTS).filter((level) => level !== "default");
        const defaultEffort = seen?.defaultEffort && seen.defaultEffort !== "default" ? seen.defaultEffort : undefined;
        return { ...model, efforts, ...(defaultEffort ? { defaultEffort } : {}) };
      });
      // `signedIn` is Perry's "can answer now", and OpenCode's free models
      // answer with no provider account at all. Whether one is connected is
      // `opencode auth list`'s answer, which login() starts from and the
      // message below tells apart.
      const signedIn = models.length > 0;
      const connected = signedIn && (await this.authenticated());
      return {
        ...base, installed: true, version, signedIn,
        auth: connected ? { type: "opencode", label: "OpenCode" } : {},
        models: signedIn ? modelsOr(models, this.label) : [],
        message: signedIn ? connected ? undefined : "Free models need no account. Run `opencode auth login` on this computer to use your own providers."
          : "Run `opencode auth login` on this computer to sign in.",
        error: signedIn ? undefined : listError,
      };
    } catch (error) {
      return { ...base, installed: true, version, signedIn: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * OpenCode signs in only in its own terminal flow: the owner runs `opencode
   * auth login` on the computer. Perry shows the command and waits for
   * `opencode auth list` to show an account; it starts no child of its own.
   */
  async login(): Promise<LoginFlow> {
    this.listed = null;
    if (await this.authenticated()) return { interaction: null, done: Promise.resolve(), cancel: () => {} };
    const finish = (signedIn: Promise<void>) => signedIn.finally(() => { this.listed = null; this.kill(); });
    const waiting = waitForSignIn(async () => { this.listed = null; return await this.authenticated(); }, "Signing in to OpenCode");
    return { interaction: { type: "terminal", command: "opencode auth login" }, done: finish(waiting.done), cancel: waiting.cancel };
  }

  /** A logout that did not remove the credentials says so, rather than letting the owner think it did. */
  async logout(): Promise<void> {
    try {
      const ran = await runCli(this.cli, ["auth", "logout"], 30_000);
      if (ran.code !== 0) throw new Error(ran.stderr.trim().split("\n")[0] || `opencode auth logout exited with code ${ran.code}`);
    } finally {
      this.listed = null;
      this.kill();
    }
  }
}
