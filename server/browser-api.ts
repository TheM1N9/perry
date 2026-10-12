import { isAdmin } from "./api";
import { backend } from "./index";
import { z } from "zod";

export class BrowserDenied extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const loopback = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
/** Owner bearer key + same-origin protected transport. Pet keys and arbitrary pages cannot call this. */
export async function authorizeBrowser(request: Request, conversationId: string) {
  if (!isAdmin(request)) throw new BrowserDenied("Unlock the owner dashboard first.", 401);
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin !== url.origin || request.headers.get("sec-fetch-site") === "cross-site") throw new BrowserDenied("Browser controls require a same-origin dashboard request.", 403);
  if (!loopback(url) && url.protocol !== "https:") throw new BrowserDenied("Remote browser viewing requires HTTPS. Open Perry locally or through an HTTPS connection.", 403);
  if (process.env.PERRY_BROWSER_VIEW !== "1") throw new BrowserDenied("Live browser viewing is disabled. Enable PERRY_BROWSER_VIEW=1 on the browser host.", 404);
  const chat = z.object({ contact: z.unknown().optional() }).parse((await backend().runQuery("dashboard:getChat", { key: request.headers.get("x-perry-key"), id: conversationId })).value);
  if (chat.contact) throw new BrowserDenied("The owner's browser is unavailable in contact chats.", 403);
  return { importEnabled: process.env.PERRY_BROWSER_IMPORT === "1" && loopback(url) && !request.headers.has("x-forwarded-for") };
}
export function browserFailure(error: unknown) {
  // Browser/CDP/SQLite errors may contain URL query strings or credentials. Never log request bodies/raw errors.
  const message = error instanceof BrowserDenied ? error.message : error instanceof Error && /^(The browser|Browser control|The owner|Another browser|Look again|Pause and|Take over|Session import|Close Firefox|Firefox cookies|This Firefox|This profile|That profile|The import|The source|No imported|Import rollback|The cancelled|Capture is|Navigation failed)/.test(error.message) ? error.message : "Browser operation failed. Refresh the view or sign in manually.";
  return Response.json({ error: message }, { status: error instanceof BrowserDenied ? error.status : 409, headers: { "Cache-Control": "no-store" } });
}
