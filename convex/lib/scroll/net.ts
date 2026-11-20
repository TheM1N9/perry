import { fetchPublic } from "../../web";
import { SourceError, type Http } from "./types";

/** The only hosts a scroll source sends the owner's key to: each provider's own API. */
export const KEY_HOSTS = new Set(["api.x.com", "api.scrapecreators.com", "api.producthunt.com", "treg.to", "www.reddit.com", "oauth.reddit.com"]);
const REQUEST_MS = 15_000;
const BODY_BYTES = 5 * 1024 * 1024;

/**
 * How internet_scroll reaches the internet. Public reads go through Perry's
 * guarded fetch (no private addresses, no credentials); a keyed request goes
 * over https to its provider's own host only, with no redirects. One object, so
 * a replay can stand in for the internet (artifacts/scroll/run.mjs).
 */
export const transport = {
  async get(url: string, signal: AbortSignal): Promise<Http> {
    const page = await fetchPublic(url, AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]));
    return { status: page.status, body: page.body, headers: page.retryAfter ? { "retry-after": page.retryAfter } : {} };
  },
  async send(url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }, signal: AbortSignal): Promise<Http> {
    const target = new URL(url);
    if (target.protocol !== "https:" || !KEY_HOSTS.has(target.hostname)) throw new SourceError("a key goes only to its own provider's API");
    const response = await fetch(target, { method: init.method, headers: init.headers, body: init.body, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]) });
    if (Number(response.headers.get("content-length") ?? 0) > BODY_BYTES) { await response.body?.cancel().catch(() => {}); throw new SourceError("an answer over 5 MB"); }
    // Counted as it arrives: the declared length can be missing or wrong.
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body?.getReader();
    for (let read = await reader?.read(); reader && read && !read.done; read = await reader.read()) {
      bytes += read.value.byteLength;
      if (bytes > BODY_BYTES) { await reader.cancel().catch(() => {}); throw new SourceError("an answer over 5 MB"); }
      chunks.push(read.value);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const headers: Record<string, string> = {};
    for (const name of ["x-treg-cost-micro", "retry-after"]) { const value = response.headers.get(name); if (value !== null) headers[name] = value; }
    return { status: response.status, body, headers };
  },
};
