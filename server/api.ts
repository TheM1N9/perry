import { timingSafeEqual } from "node:crypto";
import { backend } from "./index";
import { ArgumentError, NotFound } from "./runtime";

/**
 * What /api/backend's route handlers share: running a function by name and
 * turning its outcome into a response. A thrown error goes back as its
 * message, which the dashboard shows as it showed Convex's.
 */

export async function runCall(request: Request, options: { internal: boolean }) {
  let body: { path?: unknown; args?: unknown };
  try { body = await request.json(); } catch { return Response.json({ error: "The request body is not JSON." }, { status: 400 }); }
  if (typeof body.path !== "string") return Response.json({ error: "Name the function to call as path." }, { status: 400 });
  try {
    const result = await backend().call(body.path, body.args ?? {}, options);
    return Response.json({ value: result.value ?? null, ...(result.reads ? { reads: result.reads } : {}), ...(result.writes ? { writes: result.writes } : {}) });
  } catch (error) {
    const status = error instanceof NotFound ? 404 : error instanceof ArgumentError ? 400 : 500;
    if (status === 500) console.error(`[perry] ${body.path} failed: ${error instanceof Error ? error.stack : String(error)}`);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
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
