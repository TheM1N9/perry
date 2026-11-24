import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { openTerminalProcess } from "./terminal-process";
import type { AgentDeviceClient } from "agent-device";
import { BackendClient } from "../client/backend";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { machineCommand, type GitStatus, type MachineCommand, type DeviceInventory } from "../lib/machine-protocol";
import { HOME } from "./home";

export function projectDirectory(projectId: string) { return join(HOME, "workspaces", projectId); }

const command = (binary: string, args: string[], cwd: string, limit = 1024 * 1024) => new Promise<string>((done, fail) => {
  execFile(binary, binary === "git" ? ["--literal-pathspecs", ...args] : args, { cwd, encoding: "utf8", windowsHide: true, timeout: 120000, maxBuffer: limit, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout, stderr) => error ? fail(new Error(stderr?.trim() || error.message)) : done(stdout));
});
type Terminal = { pty: Awaited<ReturnType<typeof openTerminalProcess>>; chat: Id<"conversations">; cwd: string; output: string; offset: number; status: "running" | "exited"; dirty: boolean; data: { dispose(): void }; exit: { dispose(): void } };
type Device = { client: AgentDeviceClient; chat: string; viewedAt: number };

export class MachineHost {
  private terminals = new Map<string, Terminal>();
  private devices = new Map<string, Device>();
  private queued = new Map<string, Doc<"machineRequests">>();
  private pumping = false;
  private runningLanes = new Set<string>();
  private stopped = false;
  private reporting = false;
  private receipts = new Map<string, { id: Id<"machineRequests">; result?: string; error?: string }>();
  private retryAt = 0;
  private receiptDir = join(HOME, "machine-results");
  private timer?: ReturnType<typeof setInterval>;
  private flushing: Promise<void> | null = null;
  constructor(private client: BackendClient, private token: string, private workdir: string) {}
  async start() {
    await mkdir(this.receiptDir, { recursive: true });
    for (const file of await readdir(this.receiptDir)) {
      if (!/^[a-z0-9]+\.json$/i.test(file)) continue;
      const receipt = JSON.parse(await readFile(join(this.receiptDir, file), "utf8")) as { id: Id<"machineRequests">; result?: string; error?: string };
      this.receipts.set(receipt.id, receipt);
    }
    await this.flushReceipts();
    await this.client.mutation(api.machines.recover, { token: this.token, receipts: [...this.receipts.values()].map(receipt => receipt.id) });
    this.timer = setInterval(() => { void this.report(); this.expire(); if (Date.now() > this.retryAt) { this.retryAt = Date.now() + 2000; void this.flushReceipts().then(() => this.pump()); } }, 150);
    this.timer.unref();
  }
  accept(requests: Doc<"machineRequests">[]) {
    if (this.stopped) return;
    this.queued = new Map(requests.map(request => [request._id, request]));
    void this.pump();
  }
  private async pump() {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      for (const [id, queued] of [...this.queued]) {
        if (this.stopped || this.runningLanes.size >= 4) break;
        const input = machineCommand.parse(JSON.parse(queued.input));
        const lane = input.kind.startsWith("terminal.") ? `terminal:${"sessionId" in input ? input.sessionId : queued.conversationId}`
          : input.kind.startsWith("device") ? `device:${queued.conversationId}` : `workspace:${queued.projectId ?? queued.conversationId}`;
        if (this.runningLanes.has(lane)) continue;
        const request = await this.client.mutation(api.machines.claim, { token: this.token, id: id as Id<"machineRequests"> });
        if (!request) continue;
        this.queued.delete(id); this.runningLanes.add(lane);
        void this.perform(request, input).catch(error => console.error(`Computer result could not be saved: ${String(error)}`)).finally(() => { this.runningLanes.delete(lane); void this.pump(); });
      }
    } catch (error) { console.error(`Computer request delivery paused: ${String(error)}`); }
    finally { this.pumping = false; }
  }
  private async perform(request: Doc<"machineRequests">, input: MachineCommand) {
    const receipt: { id: Id<"machineRequests">; result?: string; error?: string } = { id: request._id };
    try { receipt.result = JSON.stringify(await this.execute(request, input)); }
    catch (error) { receipt.error = error instanceof Error ? error.message : String(error); }
    const path = join(this.receiptDir, `${request._id}.json`);
    await writeFile(`${path}.tmp`, JSON.stringify(receipt), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
    this.receipts.set(request._id, receipt);
    await this.flushReceipts();
  }
  private flushReceipts(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.deliverReceipts().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  private async deliverReceipts() {
    for (const [id, receipt] of this.receipts) {
      try { await this.client.mutation(api.machines.finish, { token: this.token, ...receipt }); await unlink(join(this.receiptDir, `${id}.json`)); this.receipts.delete(id); }
      catch (error) { console.error(`Could not acknowledge computer request ${id}: ${String(error)}`); }
    }
  }
  private async cwd(request: Doc<"machineRequests">) {
    const cwd = request.cwd ?? (request.projectId ? projectDirectory(request.projectId) : this.workdir);
    if (request.projectId && !request.cwd) await mkdir(cwd, { recursive: true });
    return realpath(cwd);
  }
  private terminalFor(id: string, chat: string) {
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.chat !== chat || terminal.status !== "running") throw new Error("This terminal closed. Open a new terminal.");
    return terminal;
  }
  private async execute(request: Doc<"machineRequests">, input: MachineCommand): Promise<unknown> {
    const cwd = await this.cwd(request), chat = request.conversationId;
    switch (input.kind) {
      case "terminal.open": {
        for (const [id, terminal] of this.terminals) if (terminal.chat === chat && terminal.status === "running" && terminal.cwd === cwd) { return { sessionId: id, cwd }; }
        if ([...this.terminals.values()].filter(terminal => terminal.status === "running").length >= 4) throw new Error("Close a terminal before opening another. Four terminals can run on this computer.");
        const env = { ...process.env } as Record<string, string>;
        for (const name of ["DASHBOARD_KEY", "TELEGRAM_BOT_TOKEN", "COMPOSIO_API_KEY", "ELECTRON_RUN_AS_NODE"]) delete env[name];
        const pty = await openTerminalProcess(process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/sh", process.platform === "win32" ? ["-NoLogo"] : [], { cwd, env, name: "xterm-256color", cols: input.cols, rows: input.rows });
        const id = randomUUID();
        const terminal: Terminal = { pty, chat, cwd, output: "", offset: 0, status: "running", dirty: true, data: { dispose() {} }, exit: { dispose() {} } };
        terminal.data = pty.onData(data => { terminal.output += data; terminal.offset += data.length; terminal.output = terminal.output.slice(-131072); terminal.dirty = true; });
        terminal.exit = pty.onExit(({ exitCode }) => { terminal.output = `${terminal.output}\r\n[Process exited ${exitCode}]\r\n`.slice(-131072); terminal.offset += `\r\n[Process exited ${exitCode}]\r\n`.length; terminal.status = "exited"; terminal.dirty = true; });
        this.terminals.set(id, terminal);
        try { await this.client.mutation(api.machines.terminal, { token: this.token, conversationId: chat, sessionId: id, cwd, output: "", offset: 0, status: "running" }); }
        catch (error) { this.closeTerminal(id, chat); throw error; }
        return { sessionId: id, cwd };
      }
      case "terminal.input": this.terminalFor(input.sessionId, chat).pty.write(input.text); return { accepted: true };
      case "terminal.resize": this.terminalFor(input.sessionId, chat).pty.resize(input.cols, input.rows); return { resized: true };
      case "terminal.close": this.closeTerminal(input.sessionId, chat); return { closed: true };
      case "workspace.setup": {
        if (!request.projectId || !isAbsolute(input.path)) throw new Error("Choose an absolute workspace path for this project.");
        const source = await realpath(input.path);
        if (!(await stat(source)).isDirectory()) throw new Error("The workspace must be a directory.");
        if (input.mode === "folder") return { path: source, mode: input.mode };
        const repository = (await command("git", ["rev-parse", "--show-toplevel"], source)).trim();
        if (!input.branch || input.branch.startsWith("-") || input.base.startsWith("-")) throw new Error("Choose a valid branch and base reference.");
        await command("git", ["check-ref-format", "--branch", input.branch], repository);
        await command("git", ["rev-parse", "--verify", `${input.base}^{commit}`], repository);
        const path = join(HOME, "worktrees", request.projectId, input.branch.replace(/[^a-zA-Z0-9_.-]/g, "_"));
        await mkdir(join(HOME, "worktrees", request.projectId), { recursive: true });
        await command("git", ["worktree", "add", "-b", input.branch, path, input.base], repository);
        return { path, mode: input.mode, repository, branch: input.branch };
      }
      case "git.status": return this.gitStatus(cwd);
      case "git.diff": {
        const root = (await command("git", ["rev-parse", "--show-toplevel"], cwd)).trim();
        const path = resolve(root, input.file);
        if (isAbsolute(input.file) || relative(root, path).startsWith(`..${sep}`) || relative(root, path) === "..") throw new Error("Choose a file in this repository.");
        const status = await this.gitStatus(root), found = status.files.find(file => file.path === input.file);
        if (!found) return { diff: "This file has no changes." };
        if (found.index === "?" && found.working === "?") {
          const canonical = await realpath(path);
          if (relative(root, canonical).startsWith("..")) throw new Error("This file links outside the repository.");
          if ((await stat(canonical)).size > 200000) return { diff: "Untracked file exceeds the preview limit. Open it in Files to inspect." };
          return { diff: `Untracked: ${input.file}\n${await readFile(canonical, "utf8")}` };
        }
        return { diff: await command("git", ["diff", "--no-ext-diff", "--no-textconv", ...(input.staged ? ["--cached"] : []), "--", input.file], root) };
      }
      case "git.stage": case "git.unstage": {
        const status = await this.gitStatus(cwd);
        if (input.files.some(file => !status.files.some(item => item.path === file))) throw new Error("Refresh the repository before changing its index.");
        const files = [...new Set(input.files.flatMap(path => { const file = status.files.find(item => item.path === path)!; return input.kind === "git.unstage" && file.original ? [path, file.original] : [path]; }))];
        await command("git", input.kind === "git.stage" ? ["add", "--", ...files] : ["reset", "--", ...files], status.root);
        return this.gitStatus(status.root);
      }
      case "git.commit": await command("git", ["commit", "-m", input.message], cwd); return this.gitStatus(cwd);
      case "devices.list": {
        const { createAgentDeviceClient } = await import("agent-device");
        const client = createAgentDeviceClient({ cwd, session: `perry-${chat}` });
        const inventory: DeviceInventory = { devices: [] }; const errors: string[] = [];
        for (const platform of process.platform === "darwin" ? ["ios", "android"] as const : ["android"] as const) {
          try { for (const device of await client.devices.list({ platform })) inventory.devices.push({ id: device.id, name: device.name, platform: platform, state: device.booted ? "Booted" : "Stopped" }); }
          catch (error) { errors.push(`${platform}: ${error instanceof Error ? error.message : String(error)}`); }
        }
        inventory.detail = errors.join("\n") || (!inventory.devices.length ? "No devices found. Install Android Studio and its SDK, or use a Mac with Xcode for iOS simulators." : undefined); return inventory;
      }
      case "device.open": {
        if (this.devices.size >= 4) throw new Error("Close a device panel before opening another.");
        const { createAgentDeviceClient } = await import("agent-device");
        const sessionId = `perry-${chat}-${randomUUID()}`, client = createAgentDeviceClient({ cwd, session: sessionId });
        await client.apps.open({ app: input.app, platform: input.platform, ...(input.platform === "ios" ? { udid: input.deviceId } : { serial: input.deviceId }), timeoutMs: 90000 });
        this.devices.set(sessionId, { client, chat, viewedAt: Date.now() }); return { sessionId };
      }
      case "device.screenshot": case "device.action": case "device.close": {
        const device = this.devices.get(input.sessionId);
        if (!device && input.kind === "device.close") return { closed: true };
        if (!device || device.chat !== chat) throw new Error("This device panel closed. Open the app again.");
        device.viewedAt = Date.now();
        if (input.kind === "device.close") { await device.client.sessions.close(); this.devices.delete(input.sessionId); return { closed: true }; }
        if (input.kind === "device.action") {
          if (input.action === "tap") { if (input.x === undefined || input.y === undefined) throw new Error("Tap coordinates are required."); await device.client.interactions.click({ x: input.x, y: input.y }); }
          else if (input.action === "type") await device.client.interactions.type({ text: input.text ?? "" });
          else await device.client.command[input.action]();
        }
        const dir = join(HOME, "device-frames", chat); await mkdir(dir, { recursive: true });
        const capture = await device.client.capture.screenshot({ path: join(dir, "frame.png"), scale: 0.5 });
        const bytes = await readFile(capture.path);
        if (bytes.length > 1000000) throw new Error("Device screenshot exceeds the panel limit.");
        if (!capture.logicalWidth || !capture.logicalHeight) throw new Error("The device did not report logical screen dimensions. Update agent-device before using this panel.");
        return { image: `data:image/png;base64,${bytes.toString("base64")}`, width: capture.logicalWidth, height: capture.logicalHeight };
      }
    }
  }
  private async gitStatus(cwd: string): Promise<GitStatus> {
    const root = (await command("git", ["rev-parse", "--show-toplevel"], cwd)).trim();
    const branch = (await command("git", ["branch", "--show-current"], root)).trim() || "Detached HEAD";
    const entries = (await command("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], root)).split("\0").filter(Boolean);
    const files: GitStatus["files"] = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index], original = /[RC]/.test(entry.slice(0, 2)) ? entries[++index] : undefined;
      files.push({ path: entry.slice(3), index: entry[0], working: entry[1], ...(original ? { original } : {}) });
    }
    return { root, branch, files };
  }
  private async report() {
    if (this.reporting || this.stopped) return;
    this.reporting = true;
    try {
      for (const [sessionId, terminal] of this.terminals) {
        if (!terminal.dirty) continue;
        terminal.dirty = false;
        try {
          const keep = await this.client.mutation(api.machines.terminal, { token: this.token, conversationId: terminal.chat, sessionId, cwd: terminal.cwd, output: terminal.output, offset: terminal.offset, status: terminal.status });
          if (!keep) this.closeTerminal(sessionId, terminal.chat);
        }
        catch { terminal.dirty = true; }
        if (terminal.status === "exited" && !terminal.dirty) { terminal.data.dispose(); terminal.exit.dispose(); this.terminals.delete(sessionId); }
      }
    } finally { this.reporting = false; }
  }
  private closeTerminal(id: string, chat: string) {
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.chat !== chat) return;
    terminal.pty.kill(); terminal.status = "exited"; terminal.dirty = true;
  }
  private expire() {
    for (const [id, device] of this.devices) if (Date.now() - device.viewedAt > 15 * 60000) { this.devices.delete(id); void device.client.sessions.close().catch(error => console.error(`Could not close idle device: ${String(error)}`)); }
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true; clearInterval(this.timer); this.queued.clear();
    for (const terminal of this.terminals.values()) { terminal.data.dispose(); terminal.exit.dispose(); terminal.pty.kill(); }
    this.terminals.clear();
    for (const device of this.devices.values()) void device.client.sessions.close().catch(error => console.error(`Could not close device: ${String(error)}`));
    this.devices.clear();
  }
}
