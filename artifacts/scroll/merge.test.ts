import { test } from "node:test";
import assert from "node:assert/strict";
import { epoch, item, merge, num, rank, rowsOf, seenKey, type Post } from "../../convex/lib/scroll/merge";

// The merge on its own, no network: `pnpm test` (bun test). Cases: failure-cases.md.
// The first five are the reference script's selftest (treg's doomscroll, Apache-2.0), ported.
const now = 1_800_000_000;
const post = (fields: Partial<Post>): Post => ({ source: "x", url: "", text: "", author: null, created: now, views: 0, likes: 0, comments: 0, shares: 0, ...fields });

test("dates: relative, unix seconds, unix milliseconds, digit strings, ISO and RFC 2822", () => {
  assert.equal(epoch("3 hours ago", now), now - 10_800);
  assert.equal(epoch(1_700_000_000_000, now), 1_700_000_000);
  assert.equal(epoch(1_700_000_000, now), 1_700_000_000);
  assert.equal(epoch("1700000000", now), 1_700_000_000);
  assert.equal(epoch("2026-11-20T10:00:00Z", now), Date.parse("2026-11-20T10:00:00Z") / 1000);
  assert.equal(epoch("Fri, 20 Nov 2026 10:00:00 GMT", now), Date.parse("2026-11-20T10:00:00Z") / 1000);
  assert.equal(epoch("2 days ago", now), now - 172_800);
  assert.equal(epoch("yesterday-ish", now), null);
  assert.equal(epoch(undefined, now), null);
  assert.equal(epoch(true, now), null);
});

test("counts: separators, suffixes, text and booleans", () => {
  assert.equal(num("110,617 views"), 110_617);
  assert.equal(num("1.2K"), 1200);
  assert.equal(num("3M"), 3_000_000);
  assert.equal(num(42), 42);
  assert.equal(num(true), 0);
  assert.equal(num(undefined), 0);
  assert.equal(num("no views"), 0);
});

test("rows: the longest list of objects, unwrapped from aweme_info or a listing's data", () => {
  assert.deepEqual(rowsOf({ output: { videos: [{ aweme_info: { desc: "a" } }] } }), [{ desc: "a" }]);
  assert.deepEqual(rowsOf({ data: { children: [{ kind: "t3", data: { title: "a" } }, { kind: "t3", data: { title: "b" } }] } }), [{ title: "a" }, { title: "b" }]);
  assert.deepEqual(rowsOf([]), []);
  assert.deepEqual(rowsOf(null), []);
});

test("links: a Reddit thread, not its image; no tracking on TikTok or X; YouTube from its id", () => {
  assert.ok(item("reddit", { subreddit: "x", id: "1", url: "https://i.redd.it/a.png" }, now).url.endsWith("/r/x/comments/1"));
  assert.equal(item("reddit", { permalink: "/r/x/comments/2/title/", title: "t" }, now).url, "https://www.reddit.com/r/x/comments/2/title");
  assert.equal(item("tiktok", { share_url: "https://www.tiktok.com/@a/video/1?is_from_webapp=1", desc: "d" }, now).url, "https://www.tiktok.com/@a/video/1");
  assert.equal(item("x", { url: "https://x.com/a/status/1?s=20", text: "t" }, now).url, "https://x.com/a/status/1");
  assert.equal(item("youtube", { video_id: "abcdefghijk", title: "t" }, now).url, "https://www.youtube.com/watch?v=abcdefghijk");
  const tiktok = item("tiktok", { desc: "a  clip\n here", create_time: now - 60, author: { unique_id: "ada" }, statistics: { play_count: 9, digg_count: 3, comment_count: 2, share_count: 1 } }, now);
  assert.deepEqual([tiktok.text, tiktok.author, tiktok.created, tiktok.views, tiktok.likes, tiktok.comments, tiktok.shares], ["a clip here", "ada", now - 60, 9, 3, 2, 1]);
});

test("near duplicates: the same words under another link keep only the better one", () => {
  const a = post({ text: "same launch post here today friends", url: "u1", likes: 10 });
  assert.deepEqual(rank([a, { ...a, url: "u2", likes: 1 }], 86_400, now).map((x) => x.url), ["u1"]);
  assert.deepEqual(rank([a, { ...a, likes: 1, text: "something else entirely different words here" }], 86_400, now).map((x) => x.url), ["u1"]);
  // Short texts are too thin to call duplicates.
  const short = post({ text: "wow nice", url: "s1" });
  assert.equal(rank([short, { ...short, url: "s2" }], 86_400, now).length, 2);
});

test("ranking: within its platform and by absolute reach, so neither a quiet nor a loud platform takes over", () => {
  const posts = [
    post({ source: "tiktok", url: "t1", text: "viral clip one", views: 2_000_000, likes: 300_000, comments: 4000, shares: 9000 }),
    post({ source: "tiktok", url: "t2", text: "small clip two", views: 900, likes: 20, comments: 1 }),
    post({ source: "hackernews", url: "h1", text: "best story on hn", likes: 400, comments: 250 }),
    post({ source: "hackernews", url: "h2", text: "quiet story on hn", likes: 3, comments: 0 }),
  ];
  const ranked = rank(posts, 86_400, now).map((x) => x.url);
  assert.equal(ranked[0], "t1");
  assert.ok(ranked.indexOf("h1") < ranked.indexOf("t2"), "the best of a quiet platform beats the worst of a loud one");
  assert.equal(ranked.at(-1), "h2");
});

test("freshness: newer ranks higher at equal engagement; an undated post sits in the middle", () => {
  const span = 86_400;
  const scores = rank([
    post({ url: "new", text: "one", likes: 5, created: now - 600 }),
    post({ url: "old", text: "two", likes: 5, created: now - 80_000 }),
    post({ url: "undated", text: "three", likes: 5, created: null }),
  ], span, now);
  assert.deepEqual(scores.map((x) => x.url), ["new", "undated", "old"]);
});

test("merge: drops posts older than the window, duplicates and what this topic already showed, and counts each", () => {
  const posts = [
    post({ source: "reddit", url: "r1", text: "a fresh thread", likes: 50, created: now - 3600 }),
    post({ source: "reddit", url: "r2", text: "an old thread", likes: 500, created: now - 90_000 }),
    post({ source: "hackernews", url: "h1", text: "a fresh story", likes: 80, created: now - 7200 }),
    post({ source: "hackernews", url: "h1", text: "a fresh story", likes: 80, created: now - 7200 }),
    post({ source: "rss", url: "f1", text: "an undated entry", created: null }),
    post({ source: "rss", url: "", text: "" }),
  ];
  const first = merge({ posts, span: 86_400, now, seen: new Set(), limit: 2 });
  assert.equal(first.dropped.old, 1);
  assert.equal(first.dropped.duplicates, 1);
  assert.equal(first.dropped.seen, 0);
  assert.equal(first.feed.length, 3);
  assert.equal(first.shown.length, 2, "only the top `limit` are shown");
  assert.deepEqual(first.counts, { hackernews: 1, reddit: 1, rss: 1 });
  // What was shown is what the next run of this topic skips; what was not shown can still come.
  const seen = new Set(first.shown.map(seenKey));
  const second = merge({ posts, span: 86_400, now, seen, limit: 2 });
  assert.equal(second.dropped.seen, 2);
  assert.deepEqual(second.shown.map((x) => x.url), first.feed.filter((x) => !seen.has(seenKey(x))).map((x) => x.url));
  const third = merge({ posts, span: 86_400, now, seen: new Set([...seen, ...second.shown.map(seenKey)]), limit: 2 });
  assert.equal(third.shown.length, 0);
  assert.equal(third.dropped.seen, 3);
});

test("seen key: the link, or the start of the text for a post without one", () => {
  assert.equal(seenKey(post({ url: "https://a.example/1", text: "x" })), "https://a.example/1");
  assert.equal(seenKey(post({ text: "y".repeat(200) })), "y".repeat(80));
});
