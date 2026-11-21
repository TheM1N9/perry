import { z } from "zod";
import { hash, merge, seenKey, WINDOWS, type Post, type Window } from "./merge";
import { NotSetUp, PLATFORMS, KEYS, reason, type Fetched, type Plan, type Platform, type Services, type Source } from "./types";
import { hackernews } from "./sources/hackernews";
import { reddit } from "./sources/reddit";
import { rss } from "./sources/rss";
import { youtube } from "./sources/youtube";
import { xApi } from "./sources/x";
import { scrapecreators } from "./sources/scrapecreators";
import { producthunt, producthuntFeed } from "./sources/producthunt";
import { lobsters } from "./sources/lobsters";
import { news } from "./sources/news";
import { treg } from "./sources/treg";

/**
 * internet_scroll: what people posted about a topic in the last hours, across
 * platforms (skills/scroll/SKILL.md). Every platform asked is in the coverage
 * line: its count of new posts, why it failed, or how to set it up.
 *
 * Sources, best first for each platform: one set up answers it; a source that
 * fails is not swapped for another, and no request is tried more than twice.
 * A new source is a file in sources/ and a line here.
 */
export const SOURCES: Source[] = [hackernews, reddit, lobsters, youtube, news, xApi, scrapecreators, producthunt, producthuntFeed, treg, rss];

export const scrollInput = z.object({
  topic: z.string().trim().min(2).max(200).describe("What to catch up on, in plain words. It names what this topic has already shown, so keep it the same between runs."),
  window: z.enum(Object.keys(WINDOWS) as [Window, ...Window[]]).default("24h").describe("How far back: 6h, 24h, 3d or 1w."),
  searches: z.array(z.string().trim().min(2).max(120)).max(6).optional().describe("3 to 6 keyword searches worded the way people title posts, with every spelling of the name; no time words. Defaults to the topic."),
  platforms: z.array(z.enum(PLATFORMS)).min(1).optional().describe("Only these platforms. Defaults to all of them, so the coverage line says which are not set up."),
  subreddits: z.array(z.string().trim().min(2).max(24)).max(6).optional().describe("2 to 4 subreddits where the topic lives; their top posts in the window are read."),
  feeds: z.array(z.string().url().max(2048)).max(10).optional().describe("RSS or Atom feed URLs for the topic (a company blog, a newsletter)."),
  limit: z.number().int().min(1).max(80).default(50).describe("How many posts to return, best first."),
  includeSeen: z.boolean().default(false).describe("Also return posts an earlier run of this topic showed. Off: only what is new since."),
});
export type ScrollInput = z.output<typeof scrollInput>;

export type SourceRow = { platform: Platform; status: "ok" | "empty" | "failed" | "not_set_up" | "skipped"; posts: number; calls: number; provider?: string; note?: string };
export type ScrollPost = { score: number; platform: string; url: string; link?: string; text: string; author?: string; posted: string | null; age: string; views?: number; likes?: number; comments?: number; shares?: number; via?: string };
export type ScrollResult = {
  topic: string; window: Window; since: string; searches: string[];
  posts: ScrollPost[];
  /** One line naming every platform asked: its new posts, failure or setup, and what was dropped. */
  coverage: string;
  sources: SourceRow[];
  dropped: { old: number; duplicates: number; seen: number };
  /** At least one platform answered, and nothing new was in the window since this topic's last run. */
  nothingNew: boolean;
  /** Not one platform answered: every one asked failed or is not set up. */
  noSource: boolean;
  /** What this run showed, for the next run of the topic to skip. Not shown to the agent. */
  shownKeys: string[];
};

/**
 * The name a topic's shown posts are kept under: readable, and told apart by a hash of the whole
 * topic ("C++" and "C#"), ignoring only case and spacing.
 */
export function topicKey(topic: string): string {
  const exact = topic.toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();
  const slug = exact.normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${slug || "topic"}-${hash(exact)}`;
}
const DEADLINE_MS = 40_000;

function setUpHint(platform: Platform): string {
  if (platform === "youtube") return `Connect YouTube in Apps & skills → Connectors, or save ${KEYS.treg.what} as "${KEYS.treg.names[0]}" in Settings → Logins & secrets`;
  const keys = SOURCES.filter((source) => source.key && source.platforms.includes(platform)).map((source) => `${KEYS[source.key!].what} as "${KEYS[source.key!].names[0]}"`);
  return `save ${keys.join(" or ")} in Settings → Logins & secrets`;
}
const money = (micro: number) => `$${(micro / 1e6).toFixed(micro < 10_000 ? 5 : 3).replace(/0+$/, "").replace(/\.$/, "")}`;
const age = (seconds: number) => seconds < 3600 ? `${Math.max(1, Math.round(seconds / 60))}m` : seconds < 172_800 ? `${Math.round(seconds / 3600)}h` : `${Math.round(seconds / 86_400)}d`;

export async function runScroll(input: ScrollInput, services: Services, options: { seen: Set<string>; signal: AbortSignal; now?: number; deadlineMs?: number }): Promise<ScrollResult> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const window = input.window ?? "24h";
  const searches = [...new Set((input.searches?.length ? input.searches : [input.topic]).map((search) => search.trim()))];
  const plan: Plan = { topic: input.topic, searches, subreddits: input.subreddits ?? [], feeds: input.feeds ?? [], window, span: WINDOWS[window], now };
  const platforms = PLATFORMS.filter((platform) => !input.platforms || input.platforms.includes(platform));
  // The run's own deadline, cleared when it ends; whatever a source still has in flight then is stopped.
  const stopper = new AbortController();
  const timer = setTimeout(() => stopper.abort(new DOMException("The scroll reached its deadline.", "TimeoutError")), options.deadlineMs ?? DEADLINE_MS);
  const signal = AbortSignal.any([options.signal, stopper.signal]);
  let stop = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    stop = () => reject(signal.reason);
    if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  });
  deadline.catch(() => {});

  let rows: Array<{ row: SourceRow; fetched?: Fetched }>;
  try {
    rows = await Promise.all(platforms.map(async (platform): Promise<{ row: SourceRow; fetched?: Fetched }> => {
      if (platform === "rss" && !plan.feeds.length) return { row: { platform, status: "skipped", posts: 0, calls: 0, note: "no feeds given" } };
      const candidates = SOURCES.filter((source) => source.platforms.includes(platform) && (!source.key || services.keys[source.key]));
      // Every request a source makes, retries included, counted here, so a source that failed still says how many.
      let calls = 0;
      const counted: Services = {
        ...services,
        get: (url, inner) => { calls++; return services.get(url, inner); },
        send: (url, init, inner) => { calls++; return services.send(url, init, inner); },
        internet: (request, inner) => { calls++; return services.internet(request, inner); },
        connected: { apps: () => services.connected.apps(), run: (slug, args) => { calls++; return services.connected.run(slug, args); } },
      };
      let unset = setUpHint(platform);
      for (const source of candidates) {
        try {
          const fetched = await Promise.race([source.fetch(platform, plan, counted, signal), deadline]);
          return { row: { platform, status: "ok", posts: 0, calls, provider: source.name, ...(fetched.notes.length ? { note: fetched.notes.join("; ") } : {}) }, fetched };
        } catch (error) {
          if (error instanceof NotSetUp) { unset = error.message; continue; }
          return { row: { platform, status: "failed", posts: 0, calls, provider: source.name, note: reason(error, signal.aborted ? signal : undefined) } };
        }
      }
      return { row: { platform, status: "not_set_up", posts: 0, calls, note: unset } };
    }));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    stopper.abort();
  }
  const posts: Post[] = rows.flatMap(({ fetched }) => fetched?.posts ?? []);
  const counts = merge({ posts, span: plan.span, now, seen: options.seen, limit: input.limit ?? 50 });
  // Asked to show again what earlier runs showed: the same merge without them left out.
  const merged = input.includeSeen ? merge({ posts, span: plan.span, now, seen: new Set(), limit: input.limit ?? 50 }) : counts;
  for (const { row, fetched } of rows) {
    if (row.status !== "ok") continue;
    row.posts = counts.counts[row.platform] ?? 0;
    if (!row.posts) {
      row.status = "empty";
      const inWindow = (fetched?.posts ?? []).filter((post) => post.created === null || now - post.created <= plan.span).length;
      // A source that keeps only posts about the topic says why it has none; otherwise the window does.
      row.note = inWindow ? ["nothing new since the last run", row.note].filter(Boolean).join("; ") : row.note || "no posts in the window";
    }
  }
  const answered = rows.some(({ row }) => row.status === "ok" || row.status === "empty");
  const cost = rows.reduce((sum, { fetched }) => sum + (fetched?.costMicro ?? 0), 0);
  const describe = ({ row }: (typeof rows)[number]) => {
    const via = row.provider === "treg" ? " via treg" : "";
    if (row.status === "ok") return `${row.platform} ${row.posts}${via}`;
    if (row.status === "empty") return `${row.platform} 0${via} (${row.note})`;
    // The coverage line keeps the reason short; the source row keeps how to fix it.
    if (row.status === "failed") return `${row.platform} failed (${row.note?.split("; ")[0]})`;
    if (row.status === "not_set_up") return `${row.platform} not set up`;
    return `${row.platform} skipped (${row.note})`;
  };
  const { old, duplicates, seen } = counts.dropped;
  const coverage = [
    ...rows.map(describe),
    `${duplicates} duplicate${duplicates === 1 ? "" : "s"}, ${old} too old, ${seen} already seen`,
    ...(cost ? [`${money(cost)} on treg`] : []),
  ].join(" · ");
  return {
    topic: input.topic, window, since: new Date((now - plan.span) * 1000).toISOString(), searches,
    posts: merged.shown.map((post) => ({
      score: post.score, platform: post.source, url: post.url, ...(post.link ? { link: post.link } : {}), text: post.text.slice(0, 600),
      ...(post.author ? { author: post.author } : {}), posted: post.created === null ? null : new Date(post.created * 1000).toISOString(),
      age: post.created === null ? "date unknown" : age(Math.max(0, now - post.created)),
      ...(post.views ? { views: post.views } : {}), ...(post.likes ? { likes: post.likes } : {}), ...(post.comments ? { comments: post.comments } : {}), ...(post.shares ? { shares: post.shares } : {}),
      ...(post.via ? { via: post.via } : {}),
    })),
    coverage, sources: rows.map(({ row }) => row), dropped: counts.dropped,
    // A run where nothing answered is not news that nothing happened: a job must say a source is down.
    nothingNew: answered && counts.feed.length === 0 && !merged.shown.length, noSource: !answered,
    shownKeys: merged.shown.map(seenKey),
  };
}
