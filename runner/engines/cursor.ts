import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ACCESSES } from "../../convex/lib/commands";
import type { EngineModel, EngineStatus, LoginFlow, PerryTools } from "../engine";
import { HOME } from "../home";
import { AcpEngine, modelsOr, waitForSignIn, type AcpLaunch } from "./acp";
import { commandOf, runCli } from "./process";

/**
 * Cursor's agent CLI over ACP (`cursor-agent acp`, also installed as
 * `agent`), signed in with the owner's own Cursor account (`agent login`).
 * From cursor.com/docs/cli/acp and T3 Code's Cursor provider:
 *
 *   - `agent about --format json` (userEmail null when signed out) is the
 *     status, with `--version`; `agent models` lists the models. None starts
 *     the agent.
 *   - The agent offers `cursor_login`, the CLI's own sign-in, which Perry
 *     never reads (the OS keychain or Cursor's auth.json).
 *   - Its modes are agent, plan and ask; Perry uses agent at every access. It
 *     asks before commands and edits (allow-once, allow-always, reject-once);
 *     at Full access Perry answers "allow once" itself, rather than start a
 *     second agent with --force for those chats.
 *   - It ignores the MCP servers given in session/new and reads them from the
 *     project's .cursor/mcp.json, in the folder it was started in, once they
 *     are approved. So Perry starts it in its workspace, writes its own server
 *     there (the stdio bridge, with no token in the file: the bridge reads it
 *     from Perry's home), and approves it with --approve-mcps. Only a folder
 *     inside Perry's home is written to; the owner's own ~/.cursor is never
 *     touched.
 *   - A prompt while another runs is not taken reliably, so a message sent
 *     mid-reply waits and becomes the next turn. /compress compacts.
 *   - `@cursor/sdk` is a later alternative to ACP, without approval callbacks.
 *
 * PERRY_CURSOR_COMMAND names the CLI (tests point it at a stand-in agent);
 * otherwise `cursor-agent`, then `agent`, whichever answers.
 */

const INSTALL = "Install Cursor's CLI on this computer (curl https://cursor.com/install -fsS | bash, or irm 'https://cursor.com/install?win32=true' | iex on Windows), then sign in here.";

type About = { cliVersion?: string; userEmail?: string | null; subscriptionTier?: string | null };

/** `agent about`, as JSON or, from an older CLI, as its table. */
export function parseAbout(output: string): About | null {
  try {
    const parsed = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1)) as About;
    if (parsed && typeof parsed === "object" && "userEmail" in parsed) return parsed;
  } catch {}
  const field = (name: string) => output.match(new RegExp(`${name}\\s+(.+)`, "i"))?.[1]?.trim();
  const email = field("User Email");
  if (!field("CLI Version") && !email) return null;
  return { cliVersion: field("CLI Version"), userEmail: email && !/not logged in/i.test(email) ? email : null, subscriptionTier: field("Subscription Tier") ?? null };
}

/** `agent models`: one model a line, `<id> - <name>`, the current or default one marked. */
export function parseModels(output: string): EngineModel[] {
  return [...output.matchAll(/^\s*[*-]?\s*([\w.\-[\]:/]+)\s+-\s+(.+?)\s*$/gm)].map((match): EngineModel => {
    const marked = /\((current|default)\)/i.test(match[2]);
    return { id: match[1], name: match[2].replace(/\s*\((current|default)\)\s*/i, "").trim() || match[1], isDefault: marked };
  });
}

export class CursorEngine extends AcpEngine {
  private cli: { command: string; args: string[] } | null = null;
  private listed: { at: number; models: EngineModel[] } | null = null;
  private warned = new Set<string>();

  constructor(warn?: (line: string) => void) {
    super({
      kind: "cursor",
      label: "Cursor",
      capabilities: {
        steer: "queue",
        compaction: { type: "slash-command", command: "/compress" },
        approvals: true,
        // By approvals: Cursor's own sandbox is left as the owner set it.
        sandbox: { win32: ACCESSES, darwin: ACCESSES, linux: ACCESSES },
        images: true,
        modelSwitchInSession: true,
        usage: "unavailable",
        quickTurns: false,
      },
      authMethods: ["cursor_login"],
      modes: { supervised: ["agent", "code", "default"], auto: ["agent", "code", "default"], full: ["agent", "code", "default"] },
      toolsVia: "none",
    }, warn);
  }

  /** The CLI: the override, else `cursor-agent`, else `agent` — the first that answers --version. */
  private async find(): Promise<{ cli: { command: string; args: string[] }; version: string } | null> {
    const candidates = process.env.PERRY_CURSOR_COMMAND ? [commandOf("PERRY_CURSOR_COMMAND", "cursor-agent")] : [this.cli, commandOf("", "cursor-agent"), commandOf("", "agent")].filter(Boolean) as Array<{ command: string; args: string[] }>;
    for (const cli of candidates) {
      const ran = await runCli(cli, ["--version"], 15_000).catch(() => null);
      // `agent` is a common name: only Cursor's prints a version like 2026.09.18-abc1234.
      const version = ran?.code === 0 ? ran.stdout.trim().split("\n")[0].trim() : "";
      if (/^\d{4}\.\d{2}\.\d{2}/.test(version)) { this.cli = cli; return { cli, version }; }
    }
    return null;
  }

  protected async launch(cwd?: string): Promise<AcpLaunch> {
    const found = this.cli ?? (await this.find())?.cli;
    if (!found) throw new Error(INSTALL);
    return { command: found.command, args: [...found.args, "--approve-mcps", "acp"], cwd };
  }

  /**
   * Perry's tools where Cursor reads MCP servers: <workspace>/.cursor/mcp.json,
   * merged with whatever else is there. The bridge finds the runner's token
   * in Perry's home, so the file holds none.
   */
  protected async prepareSession(cwd: string, tools: PerryTools | undefined): Promise<void> {
    if (!tools) return;
    const inside = relative(HOME, cwd);
    if (inside.startsWith("..") || /^[a-zA-Z]:/.test(inside)) {
      if (!this.warned.has(cwd)) this.warn(`Perry's tools are not offered to Cursor in ${cwd}: Perry writes Cursor's .cursor/mcp.json only in its own workspace.`);
      this.warned.add(cwd);
      return;
    }
    const file = join(cwd, ".cursor", "mcp.json");
    let config: { mcpServers?: Record<string, unknown> } = {};
    try { if (existsSync(file)) config = JSON.parse(readFileSync(file, "utf8")); } catch {}
    const server = { command: tools.stdio.command, args: tools.stdio.args, env: { PERRY_MCP_URL: tools.stdio.env.PERRY_MCP_URL, PERRY_HOME: HOME } };
    if (JSON.stringify(config.mcpServers?.[tools.name]) === JSON.stringify(server)) return;
    config.mcpServers = { ...config.mcpServers, [tools.name]: server };
    mkdirSync(join(cwd, ".cursor"), { recursive: true });
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    // The agent reads its servers as it starts: a changed file needs a new one, and the server approved.
    this.kill();
    const cli = this.cli ?? (await this.find())?.cli;
    if (cli) await runCli(cli, ["mcp", "enable", tools.name], 20_000, undefined, cwd).catch(() => {});
  }

  /** The CLI's model list, with the thinking levels a session showed for each; else what sessions showed. */
  private merged(): EngineModel[] {
    const learned = new Map(this.learnedModels().map((model) => [model.id, model]));
    if (!this.listed?.models.length) return [...learned.values()];
    return this.listed.models.map((model) => {
      const seen = learned.get(model.id);
      return seen?.efforts ? { ...model, efforts: seen.efforts, defaultEffort: seen.defaultEffort } : model;
    });
  }

  async status(): Promise<EngineStatus> {
    const base = { kind: "cursor" as const, auth: {}, models: [] };
    const found = await this.find().catch(() => null);
    if (!found) return { ...base, installed: false, signedIn: false, message: INSTALL };
    try {
      let ran = await runCli(found.cli, ["about", "--format", "json"], 15_000);
      if (ran.code !== 0) ran = await runCli(found.cli, ["about"], 15_000);
      const about = parseAbout(`${ran.stdout}\n${ran.stderr}`);
      const signedIn = Boolean(about?.userEmail);
      if (signedIn && (!this.listed || Date.now() - this.listed.at > 5 * 60_000)) {
        const models = await runCli(found.cli, ["models"], 30_000).then((out) => parseModels(out.stdout), () => []);
        this.listed = { at: Date.now(), models };
      }
      return {
        ...base, installed: true, version: found.version, signedIn,
        auth: signedIn ? { type: "cursor", label: "Cursor", email: about?.userEmail ?? undefined, plan: about?.subscriptionTier ?? undefined } : {},
        models: signedIn ? modelsOr(this.merged(), this.label) : [],
        message: signedIn ? undefined : "Run `agent login` on this computer to sign in with your Cursor account.",
      };
    } catch (error) {
      return { ...base, installed: true, version: found.version, signedIn: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Cursor signs in in a browser from its own CLI: the owner runs `agent login` there, and Settings follows. */
  async login(): Promise<LoginFlow> {
    if ((await this.status()).signedIn) return { interaction: null, done: Promise.resolve(), cancel: () => {} };
    const command = this.cli?.command.endsWith("cursor-agent") ? "cursor-agent login" : "agent login";
    const waiting = waitForSignIn(async () => (await this.status()).signedIn, "Signing in to Cursor");
    return { interaction: { type: "terminal", command }, done: waiting.done.finally(() => this.kill()), cancel: waiting.cancel };
  }

  async logout(): Promise<void> {
    const found = this.cli ?? (await this.find())?.cli;
    if (!found) throw new Error(INSTALL);
    const ran = await runCli(found, ["logout"], 30_000);
    this.listed = null;
    this.kill();
    if (ran.code !== 0) throw new Error(ran.stderr.trim() || "Cursor's logout failed.");
  }
}
