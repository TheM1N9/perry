import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { MAX_WORKER_RESULT, workerCompletion, workerEvent, workerRegistration } from "../lib/worker-webhook";

export async function notify(args: string[], env: Record<string, string>): Promise<boolean> {
  try {
    const register = args[0] === "register";
    if (register) args = args.slice(1);
    const { values } = parseArgs({ args, strict: true, options: {
      name: { type: "string" }, result: { type: "string" }, ask: { type: "string" }, chat: { type: "string" },
      token: { type: "string" }, event: { type: "string" }, port: { type: "string" },
      completion: { type: "string" },
    } });
    if (register && (values.token || values.event)) throw new Error("Registration creates its own token and event");
    if (values.completion) {
      if (register || values.completion.length > 64000 || Object.keys(values).some(key => key !== "completion" && key !== "port")) throw new Error("Invalid completion command");
      Object.assign(values, workerCompletion.parse(JSON.parse(Buffer.from(values.completion, "base64url").toString("utf8"))));
    }
    const input = workerRegistration.parse({ name: values.name, result: values.result ? resolve(values.result) : undefined,
      ...(values.ask ? { ask: values.ask } : {}), ...(values.chat ? { chat: values.chat } : {}) });
    let payload: unknown = input;
    if (!register) {
      const file = await open(input.result, "r");
      let text: string;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_WORKER_RESULT) throw new Error("Result must be a file of at most 128 KiB");
        const buffer = Buffer.alloc(MAX_WORKER_RESULT + 1);
        let size = 0;
        while (size < buffer.length) { const read = await file.read(buffer, size, buffer.length - size); if (!read.bytesRead) break; size += read.bytesRead; }
        if (size > MAX_WORKER_RESULT) throw new Error("Result exceeds 128 KiB");
        text = buffer.subarray(0, size).toString("utf8");
      } finally { await file.close(); }
      // Stable across CLI invocations as well as network retries; --event distinguishes identical later completions.
      const eventId = values.event ?? createHash("sha256").update(JSON.stringify({ ...input, text })).digest("hex");
      payload = workerEvent.parse({ ...input, eventId, text });
    }
    const port = Number(values.port ?? process.env.PERRY_PORT ?? env.PERRY_PORT ?? 7377);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
    const base = `http://127.0.0.1:${port}`;
    const key = process.env.DASHBOARD_KEY ?? env.DASHBOARD_KEY;
    if (register ? !key : !values.token && !key) throw new Error("No worker token or dashboard key available");
    for (let attempt = 0; attempt < 5; attempt++) {
      let response: Response;
      try {
        response = await fetch(`${base}/api/workers/${register ? "register" : "notify"}`, {
          method: "POST", headers: { "content-type": "application/json", ...(!register && values.token ? { authorization: `Bearer ${values.token}` } : { "x-perry-key": key! }) },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000), redirect: "error",
        });
        if (response.ok) {
          const receipt = await response.json();
          console.log(register ? JSON.stringify(receipt, null, 2) : `Perry notified (${receipt.eventId}${receipt.duplicate ? ", already received" : ""}).`);
          return true;
        }
      } catch {
        if (attempt === 4 || register) throw new Error("Perry is unreachable; retry the same command when it is running");
        await new Promise(done => setTimeout(done, 250 * 2 ** attempt)); continue;
      }
      if (!register && (response.status === 429 || response.status >= 500) && attempt < 4) {
        await new Promise(done => setTimeout(done, 250 * 2 ** attempt)); continue;
      }
      if (register && response.status === 400) {
        console.error("Worker registration refused. Check the fields and shorten the name, path or question; the completion command must fit in 7000 characters.");
        return false;
      }
      throw new Error(`Perry refused the worker request (HTTP ${response.status})`);
    }
    return false;
  } catch {
    // Parsing/fetch errors can contain the provided token or key; keep them out of worker logs.
    console.error("Worker notification failed. Check the file (128 KiB maximum), --name, --result, credentials and local Perry server; retry with the same --event.");
    return false;
  }
}
