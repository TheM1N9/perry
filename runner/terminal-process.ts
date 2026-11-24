import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { IPtyForkOptions } from "node-pty";

/** node-pty's Windows pipes require Node; the main runner may be Bun. */
export async function openTerminalProcess(file: string, args: string[], options: IPtyForkOptions) {
  const child = spawn("node", [fileURLToPath(new URL("./pty-host.cjs", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const data = new Set<(text: string) => void>(), exits = new Set<(event: { exitCode: number }) => void>();
  let stderr = "", ended = false, ready = false, startup: ReturnType<typeof setTimeout>;
  const write = (value: unknown) => { if (!ended && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(value)}\n`); };
  let resolveReady: () => void, rejectReady: (error: Error) => void;
  const opened = new Promise<void>((done, fail) => { resolveReady = done; rejectReady = fail; });
  function finish(exitCode: number) {
    if (ended) return;
    ended = true; clearTimeout(startup); lines.close(); child.stdin.destroy();
    if (!ready) rejectReady(new Error(stderr || "The terminal helper exited before opening. Check that Node.js is installed."));
    for (const listener of exits) listener({ exitCode });
    data.clear(); exits.clear();
  }
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
  child.stdin.on("error", error => { stderr = error.message; child.kill(); finish(1); });
  child.once("error", error => { stderr = error.message; finish(1); });
  child.once("exit", code => finish(code ?? 1));
  lines.on("line", line => {
    try {
      const event = JSON.parse(line) as { kind: string; data: string; message: string; exitCode: number };
      if (event.kind === "ready") { ready = true; clearTimeout(startup); resolveReady(); }
      else if (event.kind === "data") { for (const listener of data) listener(event.data); }
      else if (event.kind === "exit") finish(event.exitCode);
      else if (event.kind === "error") { stderr = event.message; child.kill(); finish(1); }
    } catch { stderr = "The terminal helper sent an invalid response."; child.kill(); finish(1); }
  });
  startup = setTimeout(() => { stderr = "The terminal helper did not start within 15 seconds."; child.kill(); finish(1); }, 15000);
  write({ kind: "open", file, args, options });
  await opened;
  return {
    write: (text: string) => write({ kind: "write", text }),
    resize: (cols: number, rows: number) => write({ kind: "resize", cols, rows }),
    kill: () => { write({ kind: "close" }); child.stdin.end(); },
    onData: (listener: (text: string) => void) => { data.add(listener); return { dispose: () => { data.delete(listener); } }; },
    onExit: (listener: (event: { exitCode: number }) => void) => { if (ended) queueMicrotask(() => listener({ exitCode: 1 })); else exits.add(listener); return { dispose: () => { exits.delete(listener); } }; },
  };
}
