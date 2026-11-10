import { timingSafeEqual } from "node:crypto";
import { asPet, Refused } from "./devices";
import { backend } from "./index";
import { ArgumentError, NotFound } from "./runtime";
import { AuthenticationError } from "../convex/lib/auth";
import { busyResponse, requestBytes, requestOriginAllowed, requestSlot, RequestLimitError } from "./request-limits";

/**
 * What /api/backend's route handlers share: running a function by name and
 * turning its outcome into a response. Authentication and validation errors
 * stay specific; unexpected failures expose no private exception details.
 */

export async function runCall(request: Request, options: { internal: boolean }) {
  if (!requestOriginAllowed(request)) return Response.json({ error: "This request came from another website." }, { status: 403 });
  const release = requestSlot("call");
  if (!release) return busyResponse();
  try {
    let body: { path?: unknown; args?: unknown };
    try { body = JSON.parse(new TextDecoder().decode(await requestBytes(request, 2 * 1024 * 1024))); }
    catch (error) {
      return Response.json({ error: error instanceof RequestLimitError ? error.message : "The request body is not JSON." }, { status: error instanceof RequestLimitError ? error.status : request.signal.aborted ? 499 : 400 });
    }
    if (!body || typeof body.path !== "string" || body.path.length > 200) return Response.json({ error: "Name the function to call as path." }, { status: 400 });
    try {
      // A desktop pet on another computer, with its own key: only what its page does (server/devices.ts).
      const args = await asPet(body.path, body.args ?? {});
      const result = await backend().call(body.path, args, options);
      return Response.json({ value: result.value ?? null, ...(result.reads ? { reads: result.reads } : {}), ...(result.writes ? { writes: result.writes } : {}) });
    } catch (error) {
      const status = error instanceof AuthenticationError ? error.status : error instanceof NotFound ? 404 : error instanceof ArgumentError ? 400 : error instanceof Refused ? 403 : 500;
      if (status === 500) {
        const operation = body.path.replace(/[^\w:./-]/g, "?").slice(0, 120);
        const name = error instanceof Error && ["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError"].includes(error.name) ? error.name : "InternalError";
        console.error(`[perry] ${operation} failed (${name}).`);
      }
      return Response.json({ error: status === 500 ? "Perry could not complete this request." : (error instanceof Error ? error.message : String(error)).slice(0, 1000) }, { status });
    }
  } finally { release(); }
}

/** The CLI's calls carry the dashboard key; with it, internal functions can be called too. */
export function isAdmin(request: Request): boolean {
  const expected = process.env.DASHBOARD_KEY;
  const provided = request.headers.get("x-perry-key");
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
