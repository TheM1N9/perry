import { ACCESSES } from "../../convex/lib/commands";
import type { EngineModel, EngineStatus, LoginFlow } from "../engine";
import { AcpEngine, modelsOr, waitForSignIn, type AcpLaunch } from "./acp";
import { updateCommand } from "../versions";
import { commandOf, runCli } from "./process";
import { DEFAULT_MODEL } from "./acp";

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

type Provider = { id: string; connections: Array<{ type: string; id?: string; name?: string }> };

/** Parse `opencode models`: one model id per line, named by its last segment. What each takes comes from ACP. */
export function parseModels(output: string): EngineModel[] {
  const ids = output.split("\n").map((line) => line.trim()).filter(Boolean);
  return ids.map((id): EngineModel => ({ id, name: id.split("/").pop() || id, isDefault: false }));
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
    // A permission evaluation hook runs after configured and saved grants,
    // including on resumed sessions. A config-only "ask" can be overridden by
    // per-agent rules or saved approvals, so it cannot enforce Perry's access.
    const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}");
    const plugin = new URL("./opencode-permissions/", import.meta.url).href;
    return {
      command: this.cli.command, args: [...this.cli.args, "acp"],
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, plugins: [...(config.plugins ?? []), plugin] }) },
    };
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
      return (await this.providers()).some((item) => item.connections.length > 0);
    } catch {
      return false;
    }
  }

  private async providers(): Promise<Provider[]> {
    const ran = await runCli(this.cli, ["auth", "list", "--format", "json"], 20_000);
    if (ran.code !== 0) throw new Error(ran.stderr.trim() || "OpenCode could not list provider accounts.");
    const found: unknown = JSON.parse(ran.stdout);
    if (!Array.isArray(found) || found.some((item) => typeof item?.id !== "string" || !Array.isArray(item.connections))) {
      throw new Error("OpenCode returned an invalid provider account list.");
    }
    return found;
  }

  async status(): Promise<EngineStatus> {
    const base: Pick<EngineStatus, "kind" | "auth" | "models" | "update"> = { kind: "opencode", auth: {}, models: [] };
    let version: string | undefined;
    try {
      const ran = await runCli(this.cli, ["--version"]);
      if (ran.code !== 0) return { ...base, installed: false, signedIn: false, message: INSTALL, error: ran.stderr.trim().split("\n")[0] || undefined };
      version = ran.stdout.trim().split("\n")[0];
      if (!/^v?2\./.test(version)) return { ...base, installed: true, version, signedIn: false, message: "Perry requires OpenCode 2.x for approval routing. Update OpenCode on this computer." };
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
        const efforts = seen?.efforts?.filter((level) => level !== "default");
        const defaultEffort = seen?.defaultEffort && seen.defaultEffort !== "default" ? seen.defaultEffort : undefined;
        return { ...model, isDefault: seen?.isDefault ?? false, ...(efforts?.length ? { efforts } : {}), ...(defaultEffort ? { defaultEffort } : {}) };
      });
      // Until a fresh ACP session reports the configured default, leave the
      // selection to OpenCode instead of treating its alphabetic list as a ranking.
      if (!models.some((model) => model.isDefault)) models.unshift(modelsOr([], this.label)[0]);
      // `signedIn` is Perry's "can answer now", and OpenCode's free models
      // answer with no provider account at all. Whether one is connected is
      // `opencode auth list`'s answer, which login() starts from and the
      // message below tells apart.
      const signedIn = models.some((model) => model.id !== DEFAULT_MODEL);
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
      const providers = await this.providers();
      for (const provider of providers) {
        for (const connection of provider.connections) {
          if (connection.type !== "credential") continue;
          if (!connection.id) throw new Error("OpenCode did not return a credential ID. Run `opencode auth logout` in a terminal.");
          const ran = await runCli(this.cli, ["auth", "logout", provider.id, connection.id], 30_000);
          if (ran.code !== 0) throw new Error(ran.stderr.trim().split("\n")[0] || `opencode auth logout exited with code ${ran.code}`);
        }
      }
      if ((await this.providers()).some((provider) => provider.connections.length > 0)) throw new Error("OpenCode still has a connected provider. Unset its provider environment variables on this computer to finish signing out.");
    } finally {
      this.listed = null;
      this.kill();
    }
  }
}
