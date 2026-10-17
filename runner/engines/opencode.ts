import { ACCESSES } from "../../convex/lib/commands";
import type { EngineModel, EngineStatus, LoginFlow } from "../engine";
import { AcpEngine, modelsOr, waitForSignIn, type AcpLaunch } from "./acp";
import { updateCommand } from "../versions";
import { commandOf, killTree, runCli, spawnEngine } from "./process";

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

/** Parse `opencode models`: one model id per line. */
const EFFORTS = ["low", "medium", "high"];

export function parseModels(output: string): EngineModel[] {
  const ids = output.split("\n").map((line) => line.trim()).filter(Boolean);
  return ids.map((id, index): EngineModel => ({
    id,
    name: id.split("/").pop() || id,
    isDefault: index === 0,
    efforts: EFFORTS,
    defaultEffort: "medium",
  }));
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
      if (!this.listed || Date.now() - this.listed.at > 2 * 60_000) {
        const ran = await runCli(this.cli, ["models"], 30_000);
        this.listed = { at: Date.now(), models: parseModels(`${ran.stdout}\n${ran.stderr}`) };
      }
      const models = this.listed.models.length ? this.listed.models : this.learnedModels();
      // OpenCode's free models need no sign-in; report signed in whenever it runs.
      const signedIn = models.length > 0;
      return {
        ...base, installed: true, version, signedIn,
        auth: signedIn ? { type: "opencode", label: "OpenCode" } : {},
        models: signedIn ? modelsOr(models, this.label) : [],
        message: !signedIn ? "Run `opencode auth login` on this computer to sign in." : undefined,
      };
    } catch (error) {
      return { ...base, installed: true, version, signedIn: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async login(): Promise<LoginFlow> {
    this.listed = null;
    if ((await this.status()).signedIn) return { interaction: null, done: Promise.resolve(), cancel: () => {} };
    const child = spawnEngine(this.cli.command, [...this.cli.args, "auth", "login"], { ...process.env });
    const exited = new Promise<number | null>((done) => { child.on("close", done); child.on("error", () => done(-1)); });
    const finish = (signedIn: Promise<void>) => signedIn.finally(() => { this.listed = null; this.kill(); });
    const waiting = waitForSignIn(async () => { this.listed = null; return (await this.status()).signedIn; }, "Signing in to OpenCode");
    return { interaction: { type: "terminal", command: "opencode auth login" }, done: finish(waiting.done), cancel: waiting.cancel };
  }

  async logout(): Promise<void> {
    try { await runCli(this.cli, ["auth", "logout"], 30_000); } catch {}
    this.listed = null;
    this.kill();
  }
}
