// Adapted from treg (Apache-2.0): src/skills/doomscroll/SKILL.md, "The merge script" (doomscroll.py),
// https://github.com/superdesigndev/treg. Ported to TypeScript and modified for Perry.

/**
 * One run's posts from every source, merged: the posts older than the window,
 * the duplicates and those this topic already showed are dropped, and the rest
 * ranked by engagement within its platform, absolute reach and freshness.
 *
 * Times are unix seconds throughout. The score only sorts the rows; the agent
 * reads them and judges (skills/scroll/SKILL.md).
 */

/** A post as every source hands it to the merge. */
export type Post = {
  source: string;
  url: string;
  text: string;
  author: string | null;
  /** When it was posted, unix seconds; null when the source did not say. */
  created: number | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  /** What a post points at, when it is not the post itself (an HN story's article). */
  link?: string;
  /** The provider that served it, when it is not the platform itself (treg, ScrapeCreators). */
  via?: string;
};
export type Scored = Post & { eng: number; pct: number; score: number };
type Row = Record<string, unknown>;

/** Where each field is found in the answers of the providers seen so far, best first. */
const FIELDS = {
  text: "text title desc description selftext tagline caption name content",
  url: "url share_url hn_url link permalink",
  author: "authorUsername author.unique_id author.username owner.username author.name channel.name snippet.channelTitle author username",
  created: "createdUtc created_utc create_time createTime created_at createdAt taken_at created published_time publishedTimeText publishedAt snippet.publishedAt",
  views: "viewCount statistics.play_count public_metrics.impression_count play_count video_play_count views number_of_views viewCountText",
  likes: "likeCount statistics.digg_count public_metrics.like_count digg_count ups score points votes votesCount likes like_count",
  comments: "replyCount statistics.comment_count public_metrics.reply_count comment_count num_comments comments commentsCount commentCount",
  shares: "retweetCount statistics.share_count public_metrics.retweet_count share_count reposts quoteCount",
} as const;
const UNIT: Record<string, number> = { second: 1, minute: 60, hour: 3600, day: 86_400, week: 604_800, month: 2_592_000, year: 31_536_000 };
export const WINDOWS = { "6h": 21_600, "24h": 86_400, "3d": 259_200, "1w": 604_800 } as const;
export type Window = keyof typeof WINDOWS;

const empty = (value: unknown) => value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)
  || (typeof value === "object" && !Array.isArray(value) && !Object.keys(value as object).length);

export function first(row: Row, field: keyof typeof FIELDS): unknown {
  for (const path of FIELDS[field].split(" ")) {
    let value: unknown = row;
    for (const part of path.split(".")) value = value && typeof value === "object" && !Array.isArray(value) ? (value as Row)[part] : undefined;
    if (!empty(value)) return value;
  }
  return undefined;
}

/** A count from a number or text: "110,617 views", "1.2K". */
export function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const match = /([\d.,]+)\s*([kmb])?/.exec(value.toLowerCase());
  if (!match) return 0;
  const count = Number.parseFloat(match[1].replace(/,/g, ""));
  return Number.isFinite(count) ? count * ({ k: 1e3, m: 1e6, b: 1e9 }[match[2] as "k" | "m" | "b"] ?? 1) : 0;
}

/** Unix seconds from seconds, milliseconds, "3 hours ago" or a date string; null when it is none of them. */
export function epoch(value: unknown, now: number): number | null {
  if (typeof value === "boolean" || empty(value)) return null;
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const seconds = Number(value);
    return seconds > 1e12 ? seconds / 1000 : seconds;
  }
  const ago = /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/.exec(String(value).toLowerCase());
  if (ago) return now - Number(ago[1]) * UNIT[ago[2]];
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}

/** The rows in a provider's answer: its longest list of objects, wherever it is. */
export function rowsOf(doc: unknown): Row[] {
  let best: Row[] = [];
  const walk = (value: unknown, depth: number) => {
    if (depth > 12 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      const rows = value.filter((x): x is Row => Boolean(x) && typeof x === "object" && !Array.isArray(x));
      if (rows.length > best.length) best = rows;
      for (const row of rows) walk(row, depth + 1);
    } else for (const inner of Object.values(value)) walk(inner, depth + 1);
  };
  walk(doc && typeof doc === "object" && !Array.isArray(doc) && "output" in doc ? (doc as Row).output : doc, 0);
  // TikTok wraps each video in aweme_info, a Reddit listing each post in data.
  return best.map((row) => {
    for (const key of ["aweme_info", "data"]) {
      const inner = row[key];
      if (inner && typeof inner === "object" && !Array.isArray(inner)) return inner as Row;
    }
    return row;
  });
}

/** One provider row as a post. */
export function item(source: string, row: Row, now: number): Post {
  let url = String(first(row, "url") ?? "");
  if (source === "reddit" && (row.permalink || (row.subreddit && row.id))) url = String(row.permalink || `/r/${row.subreddit}/comments/${row.id}`); // the thread, not the image
  if (url.startsWith("/r/")) url = `https://www.reddit.com${url}`;
  if (/tiktok\.com|x\.com|twitter\.com/.test(url)) url = url.split("?")[0];
  if (source === "youtube" && !url && typeof row.video_id === "string") url = `https://www.youtube.com/watch?v=${row.video_id}`;
  const author = first(row, "author");
  return {
    source, url: url.replace(/\/+$/, ""), text: String(first(row, "text") ?? "").split(/\s+/).filter(Boolean).join(" "),
    author: typeof author === "string" ? author : null, created: epoch(first(row, "created"), now),
    views: num(first(row, "views")), likes: num(first(row, "likes")), comments: num(first(row, "comments")), shares: num(first(row, "shares")),
  };
}

const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
const overlap = (a: Set<string>, b: Set<string>) => { let both = 0; for (const word of a) if (b.has(word)) both++; return both / (a.size + b.size - both); };

/** Scored best first, with exact and near duplicates dropped. */
export function rank(items: Post[], span: number, now: number): Scored[] {
  const scored = items.map((it): Scored => {
    let parts: Array<[number, number]> = [[it.likes, 0.45], [it.comments, 0.3], [it.shares, 0.25]];
    if (it.views) parts = [[it.views, 0.35], ...parts.map(([value, weight]): [number, number] => [value, weight * 0.65])];
    return { ...it, eng: parts.reduce((sum, [value, weight]) => sum + Math.log1p(value) * weight, 0), pct: 0.5, score: 0 };
  });
  const engs = scored.map((x) => x.eng).sort((a, b) => a - b);
  const top = engs.length ? engs[Math.floor(engs.length * 0.9)] : 0;
  for (const source of new Set(scored.map((x) => x.source))) {
    // Within its platform: 1k TikTok likes are not 1k HN points. Equal engagement, equal standing.
    const group = scored.filter((x) => x.source === source);
    const best = Math.max(...group.map((x) => x.eng));
    for (const it of group) it.pct = best ? group.filter((x) => x.eng <= it.eng).length / group.length : 0.5;
  }
  for (const it of scored) { // plus absolute reach, or the best of a quiet platform outranks a viral clip
    const fresh = it.created === null ? 0.5 : Math.max(0, 1 - (now - it.created) / span);
    const reach = top ? Math.min(1, it.eng / top) : 0.5;
    it.score = Math.round(100 * (0.4 * it.pct + 0.4 * reach + 0.2 * fresh));
  }
  const out: Scored[] = []; const urls = new Set<string>(); const texts: Array<Set<string>> = [];
  for (const it of scored.sort((a, b) => b.score - a.score)) {
    const tokens = words(it.text);
    if ((it.url && urls.has(it.url)) || (tokens.size >= 6 && texts.some((other) => overlap(tokens, other) > 0.7))) continue;
    urls.add(it.url); texts.push(tokens); out.push(it);
  }
  return out;
}

/** FNV-1a, 32 bits, as hex: enough to tell two long links apart in one topic's memory. */
export function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
/** What a later run of the same topic recognises a shown post by: its link, or the start of its text; at most 300 characters. */
export function seenKey(post: Pick<Post, "url" | "text">): string {
  const key = post.url || post.text.slice(0, 80);
  return key.length <= 300 ? key : `${key.slice(0, 280)}#${hash(key)}`;
}

export type Merged = {
  /** Every new post in the window, best first. */
  feed: Scored[];
  /** The top `limit` of them: what this run shows, and what the next run of the topic skips. */
  shown: Scored[];
  dropped: { old: number; duplicates: number; seen: number };
  /** New posts in the window per source. */
  counts: Record<string, number>;
};

export function merge(input: { posts: Post[]; span: number; now: number; seen: Set<string>; limit: number }): Merged {
  let old = 0;
  const kept: Post[] = [];
  for (const post of input.posts) {
    if (post.created !== null && input.now - post.created > input.span) old++;
    else if (post.text || post.url) kept.push(post);
  }
  const ranked = rank(kept, input.span, input.now);
  const feed = ranked.filter((post) => !input.seen.has(seenKey(post)));
  const counts: Record<string, number> = {};
  for (const post of feed) counts[post.source] = (counts[post.source] ?? 0) + 1;
  return {
    feed, shown: feed.slice(0, input.limit), counts: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))),
    dropped: { old, duplicates: kept.length - ranked.length, seen: ranked.length - feed.length },
  };
}
