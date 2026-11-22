import { createHash } from "node:crypto";
import { isAdmin } from "./api";
import { busyResponse, requestBytes, requestOriginAllowed, requestSlot, RequestLimitError } from "./request-limits";
import { MAX_WORKER_RESULT, workerEvent, workerRegistration } from "../lib/worker-webhook";
import type { Runtime } from "./runtime";

/** Worker tokens have no access to generic backend calls or registration. */
export async function workerRequest(request: Request, runtime: Pick<Runtime, "call">): Promise<Response> {
  if (!requestOriginAllowed(request)) return Response.json({ error: "Cross-site request refused." }, { status: 403 });
  const release = requestSlot("call");
  if (!release) return busyResponse();
  try {
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(await requestBytes(request, 1024 * 1024))); }
    catch (error) { return Response.json({ error: "Invalid worker request." }, { status: error instanceof RequestLimitError ? error.status : 400 }); }
    const register = new URL(request.url).pathname.endsWith("/register");
    if (body && typeof body === "object" && "text" in body && typeof body.text === "string" && Buffer.byteLength(body.text, "utf8") > MAX_WORKER_RESULT) {
      return Response.json({ error: "Result exceeds 128 KiB." }, { status: 413 });
    }
    const parsed = (register ? workerRegistration : workerEvent).safeParse(body);
    if (!parsed.success) return Response.json({ error: "Invalid worker request fields." }, { status: 400 });
    const admin = isAdmin(request);
    const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!admin && (register || !token)) return Response.json({ error: "Wrong or missing worker credentials." }, { status: 401 });
    try {
      const input = parsed.data;
      const result = register
        ? await runtime.call("workers:register", { name: input.name, result: input.result, ...(input.ask ? { ask: input.ask } : {}),
          ...(input.chat ? { conversationId: input.chat } : {}) }, { internal: true })
        : await runtime.call("workers:accept", { payload: JSON.stringify(input),
          ...(!admin && token ? { tokenHash: createHash("sha256").update(token).digest("hex") } : {}) }, { internal: true });
      return Response.json(result.value, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const status = message === "WORKER_UNAUTHORIZED" ? 401 : message === "WORKER_SCOPE" ? 403 : message === "WORKER_CONFLICT" ? 409 : 503;
      return Response.json({ error: status === 409 ? "This event id already has different result data." : status === 503 ? "Perry cannot admit this worker report yet. Retry the same event." : "Worker credentials refused." }, { status });
    }
  } finally { release(); }
}
