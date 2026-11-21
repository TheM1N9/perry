import type { InternetRequest, InternetResult } from "../internet";
import type { Post, Window } from "./merge";

/**
 * What a scroll source is: a small file that turns a plan into posts. Each
 * names the platforms it serves and the key it needs, if any; index.ts picks
 * the first one set up for each platform and says so in the coverage line.
 */

export const PLATFORMS = ["hackernews", "reddit", "lobsters", "youtube", "news", "x", "tiktok", "instagram", "producthunt", "rss"] as const;
export type Platform = typeof PLATFORMS[number];

/**
 * The keys an owner can add in Settings → Logins & secrets, found by the
 * login's name. The value is the key; a Reddit app's username is its client id.
 * Each is sent only to its own provider's API host.
 */
export const KEYS = {
  x: { names: ["X API", "X bearer token", "Twitter API"], env: "X_BEARER_TOKEN", what: "an X API bearer token" },
  scrapecreators: { names: ["ScrapeCreators", "Scrape Creators"], env: "SCRAPECREATORS_API_KEY", what: "a ScrapeCreators API key" },
  producthunt: { names: ["Product Hunt", "Product Hunt API"], env: "PRODUCT_HUNT_TOKEN", what: "a Product Hunt developer token" },
  treg: { names: ["treg", "treg token"], env: "TREG_TOKEN", what: "a treg token" },
  reddit: { names: ["Reddit app", "Reddit API"], env: "REDDIT_CLIENT_ID", what: "a Reddit app (client id as the username, secret as the password)" },
} as const;
export type KeyName = keyof typeof KEYS;
export type Key = { value: string; username?: string };

export type Plan = {
  topic: string;
  /** A few keyword searches, worded the way people title posts. */
  searches: string[];
  subreddits: string[];
  feeds: string[];
  window: Window;
  /** The window, in seconds. */
  span: number;
  /** Unix seconds. */
  now: number;
};

export type Http = { status: number; body: string; headers: Record<string, string> };

export type Services = {
  /** A public GET through Perry's guarded fetch: no credentials, no private addresses. */
  get(url: string, signal: AbortSignal): Promise<Http>;
  /** A request to a provider's own API host only, with the owner's key or headers of its own (Reddit's User-Agent). */
  send(url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }, signal: AbortSignal): Promise<Http>;
  /** Perry's internet layer: RSS/Atom feeds (lib/internet.ts). */
  internet(request: InternetRequest, signal: AbortSignal): Promise<InternetResult>;
  /**
   * The owner's connected accounts (Apps & skills → Connectors), as run_action reaches them: which apps
   * are connected, and one read-only operation of one, on the account connected for it.
   */
  connected: {
    apps(): Promise<{ configured: boolean; apps: string[]; error?: string }>;
    run(slug: string, args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }>;
  };
  keys: Partial<Record<KeyName, Key>>;
};

export type Fetched = {
  posts: Post[];
  /** Parts that failed while others answered: "r/foo failed (HTTP 404)". */
  notes: string[];
  /** What a paid provider said the run cost, in millionths of a dollar. */
  costMicro?: number;
};

export type Source = {
  /** Who serves it, as the coverage line names it. */
  name: string;
  platforms: readonly Platform[];
  /** The key it needs; none for a free source. */
  key?: KeyName;
  fetch(platform: Platform, plan: Plan, services: Services, signal: AbortSignal): Promise<Fetched>;
};

/** A source that is not set up here (no connected account): the next one for the platform is tried. */
export class NotSetUp extends Error {}
export class SourceError extends Error {}

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
  signal.addEventListener("abort", abort, { once: true });
});

/**
 * One request, tried again at most once, and only when it could not connect or
 * the server failed (5xx). A refusal, a rate limit or a bad request is final.
 */
export async function attempt(request: () => Promise<Http>, signal: AbortSignal): Promise<Http> {
  for (let tries = 0; ; tries++) {
    signal.throwIfAborted();
    try {
      const reply = await request();
      if (reply.status >= 500 && tries === 0) { await pause(400, signal); continue; }
      return reply;
    } catch (error) {
      // A request refused before or after it went (too big, not its provider's host) is not tried again.
      if (signal.aborted || tries > 0 || error instanceof SourceError) throw error;
      await pause(400, signal);
    }
  }
}

/** The JSON of a successful reply, or why there is none, in a few words. */
export function json(reply: Http): unknown {
  if (reply.status === 401) throw new SourceError("the key was refused (HTTP 401)");
  if (reply.status === 403) throw new SourceError("access refused (HTTP 403)");
  if (reply.status === 429) throw new SourceError("rate limited (HTTP 429)");
  if (reply.status < 200 || reply.status >= 300) throw new SourceError(`HTTP ${reply.status}`);
  try { return JSON.parse(reply.body); } catch { throw new SourceError("an answer that is not JSON"); }
}

/** Why something failed, in a few words for the coverage line. */
export function reason(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) return signal.reason?.name === "TimeoutError" ? "timed out" : "stopped";
  if (error instanceof SourceError || error instanceof NotSetUp) return error.message;
  if (error instanceof Error && error.name === "TimeoutError") return "timed out";
  return "could not connect";
}

/**
 * Run each part (a search, a subreddit, a feed); the posts of those that
 * answered are kept and the others noted. Throws only when every part failed.
 */
export async function parts<T>(fetched: Fetched, items: T[], label: (item: T) => string, run: (item: T) => Promise<Post[]>, options: { sequential?: boolean; signal: AbortSignal }): Promise<Fetched> {
  const failures: string[] = [];
  let failed = 0;
  /** True when the host turned this part away, so the rest of a sequential run is not asked. */
  const settle = async (item: T): Promise<boolean> => {
    try { fetched.posts.push(...await run(item)); return false; }
    catch (error) {
      failed++;
      const why = reason(error, options.signal);
      failures.push(`${label(item)}: ${why}`);
      return /refused|rate limited/.test(why);
    }
  };
  if (options.sequential) {
    // One host, one at a time; once it refuses or rate limits, the rest are not asked.
    for (const [index, item] of items.entries()) {
      if (options.signal.aborted) break;
      if (await settle(item)) { failed = items.length; if (index < items.length - 1) failures.push(`${items.length - index - 1} more not asked`); break; }
    }
  } else await Promise.all(items.map(settle));
  if (failed >= items.length && !fetched.posts.length) {
    const whys = [...new Set(failures.filter((line) => !line.endsWith("not asked")).map((line) => line.replace(/^.*?: /, "")))];
    throw new SourceError(whys.join("; ") || "no answer");
  }
  fetched.notes.push(...failures);
  return fetched;
}

export const fresh = (): Fetched => ({ posts: [], notes: [] });
/** Short words that say nothing of what a post is about. */
const FILLER = new Set(["the", "and", "for", "with", "about", "from", "what", "how", "new", "launch", "launches", "launched", "people", "posting", "are", "is", "of", "to", "in", "on"]);
const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}+#]+/gu) ?? [];
/** Filler out first, then endings: "is" must not become "i", nor "launches" "launche". */
const stem = (word: string) => word.replace(/s$/, "");
/**
 * Whether a post from a source with no search of its own (Lobsters, Product Hunt) is about the topic:
 * every meaningful word of the topic or of one search is in it. A word of three letters or fewer
 * ("AI") must be a whole word; a longer one may differ in its ending ("hiring", "hires").
 */
export function aboutTopic(plan: Pick<Plan, "topic" | "searches">): (text: string) => boolean {
  const phrases = [plan.topic, ...plan.searches].map((phrase) => [...new Set(words(phrase).filter((word) => !FILLER.has(word)).map(stem))]).filter((kept) => kept.length);
  return (text) => {
    const have = words(text).map(stem);
    const has = (word: string) => have.some((token) => word.length <= 3 ? token === word : token.startsWith(word.slice(0, Math.max(4, word.length - 2))));
    return phrases.some((kept) => kept.every(has));
  };
}

/** The body of a successful reply that is not JSON (a feed), or why there is none. */
export function text(reply: Http): string {
  if (reply.status === 404) throw new SourceError("Not Found (HTTP 404)");
  json({ ...reply, body: "null" });
  return reply.body;
}

/** HTML and entities out, whitespace collapsed, cut to a length. */
export function plain(text: unknown, max = 400): string {
  const value = String(text ?? "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x2F;/g, "/").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
export const query = (params: Record<string, string | number | undefined>) => Object.entries(params).filter(([, value]) => value !== undefined).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&");
