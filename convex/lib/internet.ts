import { z } from "zod";
import TurndownService from "turndown";
import type { FetchedPage, RawPage } from "../web";
import { scrub } from "./secrets";

export const platforms = ["web", "github", "youtube", "rss", "reddit", "x", "instagram", "linkedin"] as const;
export const operations = ["read", "search", "comments", "transcript", "feed", "account"] as const;
export type Platform = typeof platforms[number];
export type Operation = typeof operations[number];
const connector = z.object({ accountId: z.string().min(1).max(200), slug: z.string().min(1).max(200), args: z.record(z.string(), z.unknown()) });
const common = { limit: z.number().int().min(1).max(20).default(10), connector: connector.optional() };
export const requestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("read"), url: z.string().url().max(4096), ...common }),
  z.object({ operation: z.literal("comments"), url: z.string().url().max(4096), ...common }),
  z.object({ operation: z.literal("transcript"), url: z.string().url().max(4096), ...common }),
  z.object({ operation: z.literal("feed"), url: z.string().url().max(4096), ...common }),
  z.object({ operation: z.literal("search"), platform: z.enum(platforms), query: z.string().trim().min(2).max(300), ...common }),
  z.object({ operation: z.literal("account"), platform: z.enum(platforms), query: z.string().trim().min(2).max(300), ...common }),
]);
export type InternetRequest = z.infer<typeof requestSchema>;
export const DEADLINE_MS = 25_000;
const TEXT_LIMIT = 30_000;
const SENSITIVE = /^(?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|key|password|passwd|secret|authorization|cookie|signature|sig|credential|auth|jwt|x-(?:amz|goog)-(?:signature|credential|security-token))$/i;

type Capability = {
  platform: Platform; operation: Operation; backend: string; access: "public" | "connected";
  prerequisites: string[]; environments: readonly string[]; version: string; timeoutMs: number; maxResults: number;
  cost: "no_charge" | "owner_plan"; privacy: string; fallbacks: string[];
};
function capability(platform: Platform, operation: Operation, backend: string, access: Capability["access"] = "public"): Capability {
  return { platform, operation, backend, access, prerequisites: access === "connected" ? ["Configured Composio", "Active explicitly selected account", "Current read-only operation schema"] : [],
    environments: ["macOS", "Linux", "Windows"], version: access === "connected" ? "Node >=22.22.3; installed @composio/core 0.19.0" : "Node >=20.18.1; installed undici/turndown",
    timeoutMs: DEADLINE_MS, maxResults: 20, cost: access === "connected" ? "owner_plan" : "no_charge",
    privacy: access === "connected" ? "Only the selected connected account; no public fallback" : "No account credentials; public browser fallbacks use an isolated context",
    fallbacks: backend === "public_page" ? ["public_browser"] : [] };
}
/** An operation is registered separately; a readable page says nothing about its comments or account data. */
export const capabilities: Capability[] = [
  ...platforms.filter((p) => p !== "rss").map((p) => capability(p, "read", "public_page")),
  capability("web", "search", "web_search"), capability("github", "search", "github_api"),
  capability("github", "comments", "github_api"), capability("youtube", "transcript", "youtube_captions"), capability("rss", "feed", "rss_feed"),
  ...platforms.filter((p) => p !== "web" && p !== "rss").flatMap((p) => operations.filter((op) => op !== "feed").map((op) => capability(p, op, "connected", "connected"))),
];
export type Evidence = {
  kind: "source" | "search_result" | "comment" | "feed_entry" | "transcript" | "connector_data";
  id: string; url?: string; title?: string; author?: string; publishedAt?: string; updatedAt?: string; content: string;
  segments?: Array<{ startMs: number; durationMs?: number; text: string }>;
};
type FailureCode = "policy" | "auth_required" | "expired_auth" | "forbidden" | "rate_limited" | "timeout" | "cancelled" | "malformed" | "missing_transcript" | "unavailable" | "network";
export type InternetFailure = { code: FailureCode; message: string; repair: string; retryAt?: string };
export type ConnectedRead = {
  state: "available" | "setup_required" | "expired_auth" | "degraded";
  actions: Array<{ slug: string; description?: string; inputSchema?: unknown }>;
  accounts: Array<{ id: string; status: string }>;
  accountsTruncated?: boolean; checkedAt?: string; cacheAgeMs?: number;
  repair?: string; data?: unknown; backend?: string; error?: InternetFailure;
};
export type InternetResult = {
  status: "ok" | "partial" | "empty" | "unavailable" | "error";
  platform: Platform; operation: Operation; requestedUrl?: string; canonicalUrl?: string; backend: string | null;
  retrievedAt: string; cacheAgeMs: number; items: Evidence[]; sources: InternetResult[];
  coverage: { kind: string; pagesRead: number; hasMore: boolean; truncated: boolean; missingFields: string[] };
  warnings: string[]; attempts: Array<{ backend: string; status: string; code?: FailureCode }>;
  error?: InternetFailure; discovery?: ConnectedRead;
};
export type InternetServices = {
  fetch: (url: string, signal: AbortSignal) => Promise<RawPage>;
  page: (url: string, signal: AbortSignal) => Promise<FetchedPage>;
  connected: (request: InternetRequest, platform: Platform, signal: AbortSignal) => Promise<ConnectedRead>;
};
const health = new Map<string, { checkedAt: string; lastSuccessAt?: string; selectedBackend?: string; failure?: InternetFailure }>();
const sources = new Map<string, { waiters: Array<() => void> }>();
/** One read at a time per source host, including across chats; a cancelled waiter never starts work. */
async function withSource<T>(url: string, signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const key = new URL(url).hostname;
  let source = sources.get(key);
  if (!source) { source = { waiters: [] }; sources.set(key, source); }
  else {
    const queue = source;
    if (queue.waiters.length >= 20) failure("unavailable", "Too many reads are waiting on this source.", "Try again after the current reads finish.");
    await new Promise<void>((resolve, reject) => {
      const next = () => { signal.removeEventListener("abort", abort); resolve(); };
      const abort = () => { const at = queue.waiters.indexOf(next); if (at >= 0) queue.waiters.splice(at, 1); reject(signal.reason); };
      queue.waiters.push(next); signal.addEventListener("abort", abort, { once: true });
    });
  }
  try { signal.throwIfAborted(); return await read(); }
  finally { const next = source.waiters.shift(); if (next) next(); else sources.delete(key); }
}
export function diagnostics(connectedConfigured = false, browserAvailable?: boolean) {
  return capabilities.map((c) => {
    const probe = health.get(`${c.platform}:${c.operation}:${c.backend}`);
    const probeAgeMs = probe ? Math.max(0, Date.now() - Date.parse(probe.checkedAt)) : null;
    const stale = probeAgeMs !== null && probeAgeMs > 60_000;
    return { ...c, enabled: !disabled(c.backend), dependency: c.access === "public" ? "available" : connectedConfigured ? "configured" : "setup_required",
      fallbackDependency: c.fallbacks.includes("public_browser") ? browserAvailable === undefined ? "not_checked" : browserAvailable ? "browser_installed" : "browser_missing" : null,
      authentication: c.access === "public" ? "not_required" : stale ? "not_probed" : probe?.failure?.code === "expired_auth" ? "expired_auth" : probe?.selectedBackend ? "last_read_succeeded" : "not_probed", selectedBackend: stale ? null : probe?.selectedBackend ?? null,
      state: disabled(c.backend) ? "unavailable" : c.access === "connected" && !connectedConfigured ? "setup_required" : stale ? "unprobed" : probe?.failure?.code === "expired_auth" ? "expired_auth" : probe?.failure?.code === "auth_required" ? "setup_required" : probe?.failure?.code === "rate_limited" ? "rate_limited" : probe?.failure ? "degraded" : probe?.lastSuccessAt ? "ready" : "unprobed",
      probeAgeMs, stale,
      lastProbeAt: probe?.checkedAt ?? null, lastSuccessAt: probe?.lastSuccessAt ?? null, failure: probe?.failure ?? null };
  });
}
function disabled(backend: string) { return (process.env.PERRY_INTERNET_DISABLED ?? "").split(",").map((s) => s.trim()).includes(backend); }
export function platformOf(raw: string): Platform {
  const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  if (["github.com", "api.github.com", "raw.githubusercontent.com"].includes(host)) return "github";
  if (["youtube.com", "m.youtube.com", "youtu.be"].includes(host)) return "youtube";
  if (["reddit.com", "old.reddit.com", "new.reddit.com"].includes(host)) return "reddit";
  if (["x.com", "twitter.com", "mobile.twitter.com"].includes(host)) return "x";
  if (host === "instagram.com") return "instagram";
  if (host === "linkedin.com") return "linkedin";
  return "web";
}
/** No signed URLs, embedded credentials or unsafe schemes enter public reads or diagnostics. */
export function publicUrl(raw: string): string {
  const url = new URL(raw);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || [...url.searchParams.keys()].some((key) => SENSITIVE.test(key))) {
    throw new InternetError({ code: "policy", message: "That URL contains credentials or is not a public HTTP address.", repair: "Use a public source link without credentials." });
  }
  return url.toString();
}
function evidenceUrl(raw: string): string | undefined { try { return raw.length <= 4096 ? publicUrl(raw) : undefined; } catch { return undefined; } }
function cleanText(text: string): string {
  return scrub(text).text.replace(/https?:\/\/[^\s<>"')]+/gi, (url) => evidenceUrl(url) ?? "[credential-bearing URL removed]");
}
function providerData(value: unknown): unknown {
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value)) return value.map(providerData);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/token|cookie|password|secret|credential|authorization|api[_-]?key/i.test(key))
    .map(([key, item]) => [key, providerData(item)]));
  return value;
}
export class InternetError extends Error {
  constructor(readonly failure: InternetFailure) { super(failure.message); }
}
function failure(code: FailureCode, message: string, repair: string): never { throw new InternetError({ code, message, repair }); }
function classifyError(error: unknown, signal: AbortSignal): InternetFailure {
  if (signal.aborted) return signal.reason?.name === "TimeoutError"
    ? { code: "timeout", message: "The internet read reached its deadline.", repair: "Try a smaller read or try later." }
    : { code: "cancelled", message: "The internet read was cancelled.", repair: "No further sources were requested." };
  if (error instanceof InternetError) return error.failure;
  if (error instanceof Error && (error.name === "UnsafeDestinationError" || "cause" in error && error.cause instanceof Error && error.cause.name === "UnsafeDestinationError")) {
    return { code: "policy", message: "The destination or a redirect is not public.", repair: "Use a public internet address; do not retry through another backend." };
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) return { code: "malformed", message: "The source returned an unexpected format.", repair: "Read the original source in Perry's browser, or try later." };
  return { code: "network", message: "The source could not be reached.", repair: "Check the source address or try later." };
}
function date(value?: string | null) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined; }
function statusError(page: RawPage) {
  if (page.status >= 200 && page.status < 300) return;
  if (page.status === 401) failure("auth_required", "The source requires authentication.", "Use an explicitly connected account or sign in with Perry's dedicated browser.");
  if (page.status === 403) failure("forbidden", "The source denied access (403).", "Check permission on the original source. A public search is not a substitute.");
  if (page.status === 429) {
    const seconds = Number(page.retryAfter);
    const retryAt = page.retryAfter ? date(Number.isFinite(seconds) ? new Date(Date.now() + Math.max(0, seconds) * 1000).toISOString() : page.retryAfter) : undefined;
    throw new InternetError({ code: "rate_limited", message: "The source rate limited this read (429).", repair: "Wait until the rate limit resets before rechecking.", ...(retryAt ? { retryAt } : {}) });
  }
  failure("unavailable", `The source returned HTTP ${page.status}.`, "Check the original source or try later.");
}
const user = z.object({ login: z.string() }).nullable().optional();
const githubItem = z.object({ id: z.union([z.string(), z.number()]), html_url: z.string().url(), title: z.string().optional(), body: z.string().nullable().optional(), user, created_at: z.string().optional() });
const githubSearch = z.object({ total_count: z.number().nonnegative(), incomplete_results: z.boolean().optional(), items: z.array(githubItem) });
function githubEvidence(item: z.infer<typeof githubItem>, kind: Evidence["kind"]): Evidence {
  return { kind, id: String(item.id), url: evidenceUrl(item.html_url), title: item.title, author: item.user?.login, publishedAt: date(item.created_at), content: item.body ?? "" };
}
function videoId(raw: string): string | undefined {
  const url = new URL(raw);
  const id = url.hostname.replace(/^www\./, "") === "youtu.be" ? url.pathname.split("/")[1] : url.searchParams.get("v") ?? url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1];
  return id && /^[\w-]{11}$/.test(id) ? id : undefined;
}
const playerSchema = z.object({
  videoDetails: z.object({ videoId: z.string(), title: z.string(), author: z.string().optional() }),
  microformat: z.object({ playerMicroformatRenderer: z.object({ publishDate: z.string().optional() }) }).optional(),
  captions: z.object({ playerCaptionsTracklistRenderer: z.object({ captionTracks: z.array(z.object({ baseUrl: z.string().url(), languageCode: z.string(), kind: z.string().optional() })).optional() }) }).optional(),
});
/** Balanced JSON extraction, so braces inside a caption/title cannot end the player object. */
function playerJson(html: string): unknown {
  const start = /(?:var\s+)?ytInitialPlayerResponse\s*=\s*/.exec(html);
  if (!start) failure("missing_transcript", "The video did not expose a caption track.", "Try its original watch page; some videos have no accessible captions.");
  const at = start.index + start[0].length;
  let depth = 0; let quoted = false; let escaped = false;
  for (let i = at; i < html.length; i++) {
    const char = html[i];
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return JSON.parse(html.slice(at, i + 1));
  }
  failure("malformed", "The video returned an incomplete player response.", "Try its original watch page.");
}
const captionSchema = z.object({ events: z.array(z.object({ tStartMs: z.number().nonnegative().optional(), dDurationMs: z.number().nonnegative().optional(), segs: z.array(z.object({ utf8: z.string() })).optional() })) });

/** Check tag balance before the HTML DOM parser can repair broken XML into apparent evidence. */
function assertFeedXml(xml: string) {
  const stack: string[] = [];
  for (let i = 0; i < xml.length; i++) {
    if (xml[i] !== "<") continue;
    const special = xml.startsWith("<!--", i) ? "-->" : xml.startsWith("<![CDATA[", i) ? "]]>" : xml.startsWith("<?", i) ? "?>" : null;
    if (special) { const end = xml.indexOf(special, i + 2); if (end < 0) failure("malformed", "The feed contains an unfinished XML section.", "Check the original feed URL."); i = end + special.length - 1; continue; }
    let end = i + 1; let quote = "";
    for (; end < xml.length; end++) {
      const char = xml[end];
      if (quote) { if (char === quote) quote = ""; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    const tag = xml.slice(i + 1, end).trim();
    const match = /^(\/?)([\w:.-]+)(?:\s[\s\S]*|\/?)$/.exec(tag);
    if (end === xml.length || !match) failure("malformed", "The feed contains a malformed XML tag.", "Check the original feed URL.");
    if (match[1]) { if (stack.pop() !== match[2]) failure("malformed", "The feed contains mismatched XML tags.", "Check the original feed URL."); }
    else if (!tag.endsWith("/")) stack.push(match[2]);
    i = end;
  }
  if (stack.length) failure("malformed", "The feed is incomplete.", "Check the original feed URL.");
}
/** Turndown's installed DOM parser handles tags/entities; XML entities and DTDs are never expanded. */
function feedItems(xml: string, base: string): Evidence[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/<(?:rss|feed)(?:\s|>)/i.test(xml)) failure("malformed", "This is not a supported RSS or Atom feed.", "Use the site's RSS/Atom feed URL.");
  assertFeedXml(xml);
  const entries = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi)];
  if (entries.length !== [...xml.matchAll(/<(?:item|entry)(?:\s|>)/gi)].length || !/<\/(?:rss|feed)\s*>/i.test(xml)) failure("malformed", "The feed is incomplete or malformed.", "Check the feed at its original URL.");
  // One extra entry records that the requested maximum of 20 does not cover this feed.
  return entries.slice(0, 21).map((entry, index) => {
    let item: Evidence = { kind: "feed_entry", id: String(index), content: "" };
    const parser = new TurndownService();
    parser.addRule("feed-entry", { filter: (node) => ["ITEM", "ENTRY"].includes(node.nodeName), replacement: (_content, node) => {
      const text = (name: string) => node.getElementsByTagName(name)[0]?.textContent?.trim() || undefined;
      const links = Array.from(node.getElementsByTagName("feed-link"));
      const link = links.find((n) => !n.getAttribute("rel") || n.getAttribute("rel") === "alternate");
      const rawUrl = link?.getAttribute("href") ?? link?.textContent?.trim();
      item = { kind: "feed_entry", id: text("guid") ?? text("id") ?? rawUrl ?? String(index),
        url: rawUrl ? evidenceUrl(new URL(rawUrl, base).toString()) : undefined, title: text("title"),
        author: text("dc:creator") ?? text("author"), publishedAt: date(text("pubdate") ?? text("published")), updatedAt: date(text("updated")),
        content: new TurndownService().turndown(text("description") ?? text("content:encoded") ?? text("content") ?? text("summary") ?? "") };
      return "";
    } });
    parser.turndown(entry[0].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_all, value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"))
      .replace(/<link\b([^>]*?)\/>/gi, "<feed-link$1></feed-link>").replace(/<(\/?)link\b/gi, "<$1feed-link"));
    return item;
  });
}
/** Parse the public HTML search page through the existing DOM parser; snippets have no verified dates. */
function searchItems(html: string, base: string): Evidence[] {
  if (/challenge-form|anomaly\.js|bots use DuckDuckGo/i.test(html)) failure("forbidden", "Public search returned an access challenge.", "Try later or use an explicitly configured search provider; do not bypass the challenge.");
  let items: Evidence[] | undefined;
  const parser = new TurndownService();
  parser.addRule("search-results", { filter: (node) => node.nodeName === "DIV" && node.getAttribute("id") === "links", replacement: (_content, node) => {
    items = Array.from(node.querySelectorAll(".result")).slice(0, 21).flatMap((result) => {
      const anchor = result.querySelector("a.result__a");
      const href = anchor?.getAttribute("href");
      if (!href) return [];
      const link = new URL(href, base);
      const target = link.hostname === "duckduckgo.com" && link.pathname === "/l/" ? link.searchParams.get("uddg") : link.toString();
      const url = target && evidenceUrl(target);
      return url ? [{ kind: "search_result" as const, id: url, url, title: anchor?.textContent?.trim(), content: result.querySelector(".result__snippet")?.textContent?.trim() ?? "" }] : [];
    });
    return "";
  } });
  parser.turndown(html);
  if (!items?.length && !/no-results|result--no-result/i.test(html)) failure("malformed", "Public search returned no recognizable results or empty-result marker.", "Try later or use an explicitly configured search provider.");
  return items ?? [];
}
function normalize(result: InternetResult, limit: number): InternetResult {
  const seen = new Set<string>(); let remaining = TEXT_LIMIT;
  result.items = result.items.filter((item) => { const key = `${item.kind}:${item.id || item.url}`; if (seen.has(key)) return false; seen.add(key); return true; });
  if (result.items.length > limit) { result.coverage.hasMore = true; result.coverage.truncated = true; result.items = result.items.slice(0, limit); }
  let segmentBudget = TEXT_LIMIT;
  result.items = result.items.map((item) => {
    const content = cleanText(item.content).slice(0, Math.max(0, remaining));
    remaining -= content.length;
    if (content.length < item.content.length) result.coverage.truncated = true;
    const segments = item.segments?.slice(0, 500).flatMap((segment) => {
      const text = cleanText(segment.text).slice(0, Math.max(0, segmentBudget)); segmentBudget -= text.length;
      if (text.length < segment.text.length) result.coverage.truncated = true;
      return text ? [{ ...segment, text }] : [];
    });
    if (item.segments && item.segments.length > 500) result.coverage.truncated = true;
    return { ...item, id: cleanText(item.id).slice(0, 500), url: item.url && evidenceUrl(item.url), title: item.title && cleanText(item.title).slice(0, 500), author: item.author && cleanText(item.author).slice(0, 300), content, ...(segments ? { segments } : {}) };
  });
  result.coverage.missingFields = ["url", "title", "author", "publishedAt"].filter((key) => result.items.some((item) => !Reflect.get(item, key)));
  if (result.status === "ok") result.status = !result.items.length ? "empty" : result.coverage.truncated || result.coverage.hasMore ? "partial" : "ok";
  return result;
}
/** Shared read boundary; services are internal, never supplied in model-visible arguments. */
export async function executeInternet(request: InternetRequest, services: InternetServices, callerSignal: AbortSignal): Promise<InternetResult> {
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(DEADLINE_MS)]);
  const platform = "url" in request ? request.operation === "feed" ? "rss" : platformOf(request.url) : request.platform;
  const result: InternetResult = { status: "ok", platform, operation: request.operation, backend: null, retrievedAt: new Date().toISOString(), cacheAgeMs: 0, items: [], sources: [],
    coverage: { kind: request.operation, pagesRead: 0, hasMore: false, truncated: false, missingFields: [] }, warnings: [], attempts: [] };
  const attempt = (backend: string) => { result.backend = backend; result.attempts.push({ backend, status: "running" }); };
  const raw = async (url: string) => {
    const checked = publicUrl(url);
    for (let retry = 0; ; retry++) {
      signal.throwIfAborted();
      const page = await withSource(checked, signal, () => services.fetch(checked, signal));
      if ([502, 503, 504].includes(page.status) && retry === 0 && !page.retryAfter) {
        result.attempts.push({ backend: result.backend ?? "public_fetch", status: "temporary_failure" });
        await new Promise<void>((resolve, reject) => { const abort = () => { clearTimeout(timer); reject(signal.reason); }; const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 250); signal.addEventListener("abort", abort, { once: true }); });
        continue;
      }
      statusError(page); result.coverage.pagesRead++; return page;
    }
  };
  try {
    signal.throwIfAborted();
    if ("url" in request) result.requestedUrl = publicUrl(request.url);
    const route = capabilities.find((c) => c.platform === platform && c.operation === request.operation && c.access === (request.connector || request.operation === "account" ? "connected" : "public"));
    if (request.connector || request.operation === "account" || !route) {
      if (disabled("connected")) failure("unavailable", "Connected internet reads are disabled.", "Enable the connected adapter only if you want to use the configured plan.");
      attempt("connected");
      const discovered = await withSource(`https://${platform}.connected.invalid`, signal, () => services.connected(request, platform, signal));
      const { data, ...discovery } = discovered;
      result.discovery = discovery;
      if (discovered.error) throw new InternetError(discovered.error);
      if (data !== undefined) {
        result.backend = discovered.backend ?? "connected";
        result.coverage.kind = "connector_data";
        result.coverage.hasMore = true; // Provider schemas differ; never imply complete pagination from an opaque payload.
        result.warnings.push("Provider data; pagination and completeness are not verified. Missing source fields are disclosed.");
        result.items = [{ kind: "connector_data", id: request.connector?.slug ?? "connected", url: result.requestedUrl, content: JSON.stringify(providerData(data)) }];
      } else {
        result.status = "unavailable";
        result.warnings.push(discovered.actions.length ? "Connected read operations were found. Select the account and use an exact discovered slug and its input schema; no operation has run yet." : "No usable operation was discovered for this request. Discovery does not prove that the platform is unsupported.");
        result.error = { code: discovered.state === "expired_auth" ? "expired_auth" : discovered.state === "setup_required" ? "auth_required" : "unavailable", message: "This operation has not read any source.", repair: discovered.repair ?? "Use a discovered read operation with its schema, or the dedicated browser for authenticated website interaction." };
      }
    } else {
      if (disabled(route.backend)) failure("unavailable", "This internet adapter is disabled.", "Re-enable the adapter in the server configuration if needed.");
      attempt(route.backend);
      switch (request.operation) {
        case "read": {
          const url = publicUrl(request.url);
          const page = await withSource(url, signal, () => services.page(url, signal));
          if (page.attempts?.includes("browser") || page.via === "browser") {
            result.attempts[0].status = "fallback"; attempt("public_browser");
            if (!page.error && !page.via) { result.attempts[result.attempts.length - 1].status = "failed"; result.attempts[result.attempts.length - 1].code = "unavailable"; }
          }
          if (page.error) {
            if (page.errorId === "unsafe-destination") failure("policy", "The destination or a redirect is not public.", "Use a public source; do not retry through another backend.");
            if (page.status) statusError({ url, status: page.status, body: "", contentType: "", challenged: false, retryAfter: page.retryAfter });
            failure("network", "The exact source could not be read.", "Try the original source in Perry's dedicated browser; do not summarize search snippets as this page.");
          }
          signal.throwIfAborted();
          result.canonicalUrl = page.url && publicUrl(page.url); result.coverage.pagesRead = 1; result.coverage.kind = "page_text"; result.coverage.truncated = page.truncated ?? false;
          result.items = [{ kind: "source", id: result.canonicalUrl ?? result.requestedUrl!, url: result.canonicalUrl ?? result.requestedUrl, title: page.title, author: page.author, publishedAt: page.publishedAt, content: page.text ?? "" }];
          if (page.note) { result.warnings.push(scrub(page.note).text); if (!page.via) result.status = "partial"; }
          if (!page.text?.trim()) { result.items = []; result.warnings.push("The source returned no readable text; this does not prove that its content is empty."); }
          if (["reddit", "x", "instagram", "linkedin"].includes(platform)) result.warnings.push("Only publicly visible page text was read; full posts, replies, private data and platform-wide coverage are not verified.");
          break;
        }
        case "comments": {
          const url = new URL(request.url);
          const match = url.hostname.replace(/^www\./, "") === "github.com" && url.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)\/?$/);
          if (!match) failure("unavailable", "Public comments require an exact GitHub issue or pull-request URL.", "Use that issue/PR URL, or discover a connected comments operation.");
          const apiUrl = `https://api.github.com/repos/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}/issues/${match[3]}/comments?per_page=${request.limit}&page=1`;
          const page = await raw(apiUrl);
          result.items = z.array(githubItem).parse(JSON.parse(page.body)).map((item) => githubEvidence(item, "comment"));
          result.canonicalUrl = request.url; result.coverage.hasMore = /rel="next"/.test(page.link ?? "");
          result.warnings.push("Issue comments only; pull-request inline review threads are a separate operation. One bounded page was read.");
          break;
        }
        case "feed": {
          const page = await raw(request.url); result.canonicalUrl = page.url; result.items = feedItems(page.body, page.url); result.coverage.kind = "feed_entries";
          result.warnings.push("Only entries present in this feed response were read; linked articles were not fetched."); break;
        }
        case "transcript": {
          const id = videoId(request.url);
          if (!id) failure("unavailable", "A transcript needs an exact YouTube video URL.", "Use its watch, short or share link.");
          const watch = `https://www.youtube.com/watch?v=${id}`;
          const page = await raw(watch); const player = playerSchema.parse(playerJson(page.body));
          if (player.videoDetails.videoId !== id) failure("malformed", "The returned video does not match the requested video.", "Check the original watch URL.");
          const tracks = player.captions?.playerCaptionsTracklistRenderer.captionTracks ?? [];
          const track = tracks.find((t) => t.kind !== "asr") ?? tracks[0];
          if (!track) failure("missing_transcript", "No accessible caption track was returned for this video.", "Open its original watch page; captions may be unavailable or require sign-in.");
          const captionsUrl = new URL(track.baseUrl);
          if (captionsUrl.protocol !== "https:" || captionsUrl.username || captionsUrl.password || captionsUrl.port || !["www.youtube.com", "youtube.com"].includes(captionsUrl.hostname) || captionsUrl.pathname !== "/api/timedtext" || captionsUrl.searchParams.get("v") !== id) failure("policy", "The caption track points outside the requested video.", "Use its original watch page.");
          captionsUrl.searchParams.set("fmt", "json3");
          // Caption URLs may carry YouTube's own short-lived signature, obtained from this public video.
          // It is never an owner credential, accepted from tool arguments, or returned in evidence/diagnostics.
          signal.throwIfAborted();
          const captions = await withSource(captionsUrl.toString(), signal, () => services.fetch(captionsUrl.toString(), signal)); statusError(captions); result.coverage.pagesRead++;
          if (!captions.body.trim()) failure("missing_transcript", "The caption endpoint returned no transcript.", "Try the original watch page; do not infer the video's content.");
          const segments = captionSchema.parse(JSON.parse(captions.body)).events.flatMap((event) => event.segs && event.tStartMs !== undefined ? [{ startMs: event.tStartMs, ...(event.dDurationMs !== undefined ? { durationMs: event.dDurationMs } : {}), text: event.segs.map((s) => s.utf8).join("") }] : []).filter((s) => s.text.trim());
          if (!segments.length) failure("missing_transcript", "No readable caption segments were returned.", "Use the original watch page.");
          result.canonicalUrl = watch; result.coverage.kind = track.kind === "asr" ? "automatic_captions" : "manual_captions";
          result.items = [{ kind: "transcript", id, url: watch, title: player.videoDetails.title, author: player.videoDetails.author, publishedAt: date(player.microformat?.playerMicroformatRenderer.publishDate), content: segments.map((s) => `[${s.startMs}ms] ${s.text}`).join("\n"), segments }];
          result.warnings.push(`Text captions (${track.languageCode}) only; no visual inspection or audio transcription was performed.`); break;
        }
        case "search": {
          result.coverage.kind = "search_results";
          if (platform === "github") {
            const page = await raw(`https://api.github.com/search/issues?q=${encodeURIComponent(request.query)}&per_page=${request.limit}&page=1`);
            const parsed = githubSearch.parse(JSON.parse(page.body)); result.items = parsed.items.map((item) => githubEvidence(item, "search_result"));
            result.coverage.hasMore = parsed.total_count > parsed.items.length || parsed.incomplete_results === true;
            result.warnings.push("GitHub issue/PR search only; repository and code search are separate operations.");
          } else {
            const page = await raw(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(request.query)}`);
            result.items = searchItems(page.body, page.url);
            result.coverage.hasMore = result.items.length > 0;
            result.warnings.push("Best-effort DuckDuckGo HTML search snippets; ranking and search coverage are not complete. Snippet dates are not verified publication dates.");
          }
          normalize(result, request.limit);
          for (const item of result.items.slice(0, 3)) {
            signal.throwIfAborted();
            if (item.url) result.sources.push(await executeInternet(requestSchema.parse({ operation: "read", url: item.url }), services, signal));
          }
          if (result.sources.some((source) => !["ok", "empty"].includes(source.status))) result.status = "partial";
          result.warnings.push("Search snippets and retrieved originals are separate. Cite original reads for substantive findings; disclose failed originals."); break;
        }
      }
    }
    for (const attempt of result.attempts) if (attempt.status === "running") attempt.status = result.status === "unavailable" ? "unavailable" : "ok";
  } catch (error) {
    result.error = classifyError(error, signal); result.status = result.error.code === "unavailable" || result.error.code === "missing_transcript" ? "unavailable" : "error";
    result.items = [];
    const latest = [...result.attempts].reverse().find((a) => a.status === "running");
    if (latest) { latest.status = "failed"; latest.code = result.error.code; }
  }
  normalize(result, request.limit);
  result.retrievedAt = new Date().toISOString();
  const backend = result.backend?.startsWith("connected:") ? "connected" : result.backend === "public_browser" ? "public_page" : result.backend;
  const key = `${platform}:${request.operation}:${backend}`;
  const previous = health.get(key);
  const succeeded = ["ok", "partial", "empty"].includes(result.status);
  if (capabilities.some((c) => `${c.platform}:${c.operation}:${c.backend}` === key)) health.set(key, { checkedAt: result.retrievedAt, lastSuccessAt: succeeded ? result.retrievedAt : previous?.lastSuccessAt, selectedBackend: succeeded ? result.backend ?? undefined : undefined, failure: result.error });
  return result;
}
