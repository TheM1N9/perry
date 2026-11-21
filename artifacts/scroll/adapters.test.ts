import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runScroll, type ScrollInput } from "../../convex/lib/scroll/index";
import { SourceError, type Http, type Key, type KeyName, type Services } from "../../convex/lib/scroll/types";
import { executeInternet, type InternetRequest, type InternetResult } from "../../convex/lib/internet";

// Each source against recorded answers (Hacker News is a real one, trimmed), no network:
// `pnpm test` (bun test). Cases: failure-cases.md.
const fixtures = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));
const hn = fixtures("hackernews.json");
const reddit = fixtures("reddit.json");
const keyed = fixtures("keyed.json");
const youtubeAnswer = fixtures("youtube.json");
const lobstersAnswer = fixtures("lobsters.json");
const xml = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const feed = (body: string): Http => ({ status: 200, body, headers: { "content-type": "application/atom+xml" } });
/** 2026-11-20T17:20:00Z, a few hours after the newest fixture. */
const NOW = 1_795_200_000;

type Call = { via: "get" | "send"; url: string; method: string; headers: Record<string, string>; body?: string };
type Answer = Http | Error | ((call: Call) => Http | Error | Promise<Http | Error>);
const ok = (body: unknown, headers: Record<string, string> = {}): Http => ({ status: 200, body: JSON.stringify(body), headers });
const status = (code: number): Http => ({ status: code, body: "{}", headers: {} });

type Connected = { apps?: { configured: boolean; apps: string[]; error?: string }; run?: (slug: string, args: Record<string, unknown>) => { ok: boolean; data?: unknown; error?: string } };
function world(options: { routes?: Array<[RegExp, Answer]>; keys?: Partial<Record<KeyName, Key>>; internet?: (request: InternetRequest) => InternetResult | Promise<InternetResult>; connected?: Connected } = {}) {
  const calls: Call[] = [];
  const internetCalls: InternetRequest[] = [];
  const connectedCalls: Array<{ slug: string; args: Record<string, unknown> }> = [];
  const answer = async (call: Call): Promise<Http> => {
    calls.push(call);
    const route = options.routes?.find(([pattern]) => pattern.test(call.url));
    if (!route) return status(404);
    const found = typeof route[1] === "function" ? await route[1](call) : route[1];
    if (found instanceof Error) throw found;
    return found;
  };
  const services: Services = {
    get: (url) => answer({ via: "get", url, method: "GET", headers: {} }),
    send: (url, init) => answer({ via: "send", url, method: init.method, headers: init.headers, body: init.body }),
    // Feeds go through the real internet layer and its feed reader, over the same routes.
    internet: async (request) => {
      internetCalls.push(request);
      if (options.internet) return await options.internet(request);
      return await executeInternet(request, {
        fetch: async (url) => { const reply = await answer({ via: "get", url, method: "GET", headers: {} }); return { url, status: reply.status, body: reply.body, contentType: reply.headers["content-type"] ?? "", challenged: false }; },
        page: async () => { throw new Error("no page reads in these tests"); },
        connected: async () => ({ state: "setup_required", actions: [], accounts: [] }),
      }, new AbortController().signal);
    },
    connected: {
      apps: async () => options.connected?.apps ?? { configured: false, apps: [] },
      run: async (slug, args) => { connectedCalls.push({ slug, args }); return options.connected?.run?.(slug, args) ?? { ok: false, error: "not connected" }; },
    },
    keys: options.keys ?? {},
  };
  return { services, calls, internetCalls, connectedCalls };
}
const run = (input: Partial<ScrollInput>, services: Services, seen = new Set<string>(), deadlineMs?: number) =>
  runScroll({ topic: "AI hiring", window: "24h", ...input } as ScrollInput, services, { seen, now: NOW, signal: new AbortController().signal, ...(deadlineMs ? { deadlineMs } : {}) });
const source = (result: Awaited<ReturnType<typeof run>>, platform: string) => result.sources.find((row) => row.platform === platform);

test("Hacker News: one search per query inside the window, the discussion linked, the article kept", async () => {
  const { services, calls } = world({ routes: [[/hn\.algolia\.com/, ok(hn)]] });
  const result = await run({ platforms: ["hackernews"], searches: ["AI hiring", "AI jobs"] }, services);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.via, "get", "a free source goes through the guarded public fetch");
    assert.match(call.url, new RegExp(`numericFilters=created_at_i%3E${NOW - 86_400}`));
    assert.match(call.url, /tags=story/);
  }
  assert.match(calls[1].url, /query=AI%20jobs/);
  assert.equal(source(result, "hackernews")?.status, "ok");
  const apple = result.posts.find((post) => post.text.startsWith("Apple is building an AI agent"));
  assert.ok(apple);
  assert.equal(apple.url, "https://news.ycombinator.com/item?id=50573166");
  assert.equal(apple.link, "https://www.theverge.com/tech/1038227/apple-ai-agent-engineer-job-listing");
  assert.deepEqual([apple.likes, apple.comments, apple.author], [16, 11, "lavendermon"]);
  assert.equal(result.posts.filter((post) => post.url === apple.url).length, 1, "the same story from two searches is shown once");
  assert.equal(result.dropped.duplicates, 3);
});

test("Reddit without a key: one public RSS request for every subreddit, with a User-Agent that says who asks", async () => {
  const { services, calls } = world({ routes: [[/www\.reddit\.com\/r\/cscareerquestions\+recruitinghell\/top\.rss/, feed(xml("reddit-top.xml"))]] });
  const result = await run({ platforms: ["reddit"], subreddits: ["r/cscareerquestions", "recruitinghell"], searches: ["AI hiring"] }, services);
  assert.equal(calls.length, 1, "Reddit allows an anonymous reader about one request a minute");
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/r/cscareerquestions+recruitinghell/top.rss");
  assert.equal(url.searchParams.get("t"), "day");
  assert.equal(calls[0].via, "send");
  assert.match(calls[0].headers["user-agent"], /^perry-scroll\/1\.0 \(\+https:\/\/github\.com\/TheM1N9\/perry\)$/);
  assert.equal(source(result, "reddit")?.status, "ok");
  assert.equal(source(result, "reddit")?.provider, "Reddit");
  assert.deepEqual(result.posts.map((post) => post.url).sort(), [
    "https://www.reddit.com/r/cscareerquestions/comments/1gx0a1/got_rejected_by_an_ai_interviewer",
    "https://www.reddit.com/r/recruitinghell/comments/1gx1b7/recruiter_admitted_ai_screener",
  ]);
  const first = result.posts.find((post) => post.url.includes("1gx0a1"))!;
  assert.equal(first.author, "quiet_backend_dev");
  assert.equal(first.text, "Got rejected by an AI interviewer before talking to a single human. Applied to 40 roles this month. One AI video interview rejected me eleven minutes after I finished.");
  assert.equal(result.dropped.old, 1);
  assert.match(source(result, "reddit")?.note ?? "", /no keyword search/);

  const search = world({ routes: [[/www\.reddit\.com\/search\.rss/, feed(xml("reddit-top.xml"))]] });
  await run({ platforms: ["reddit"], searches: ["AI hiring"], window: "3d" }, search.services);
  assert.equal(new URL(search.calls[0].url).searchParams.get("q"), "AI hiring", "no subreddits: one search");
  assert.equal(new URL(search.calls[0].url).searchParams.get("t"), "week");
});

test("Reddit without a key: its \"Not Found\" feed, a refusal or a rate limit is a failure that says how to fix it", async () => {
  for (const [answer, why] of [[{ status: 404, body: xml("reddit-not-found.xml"), headers: {} }, /Not Found/], [feed(xml("reddit-not-found.xml").replace("<title>Not Found</title>", "<title>Not Found</title>")), /Not Found/], [status(429), /rate limited/], [status(403), /refused/]] as Array<[Http, RegExp]>) {
    const { services, calls } = world({ routes: [[/reddit\.com/, answer]] });
    const result = await run({ platforms: ["reddit"], subreddits: ["cscareerquestions"] }, services);
    assert.equal(calls.length, 1, "not retried");
    const row = source(result, "reddit");
    assert.equal(row?.status, "failed");
    assert.match(row?.note ?? "", why);
    assert.match(row?.note ?? "", /Reddit app/);
    assert.equal(result.noSource, true, "not a quiet day");
  }
});

test("Reddit with an app: each subreddit's top and a search through its API, threads not images, old ones dropped", async () => {
  const { services, calls } = world({ keys: { reddit: { username: "client-id-123", value: "client-secret-456" } }, routes: [[/access_token/, ok(reddit.token)], [/oauth\.reddit\.com\/r\/cscareerquestions\/top/, ok(reddit.top)], [/oauth\.reddit\.com\/search/, ok(reddit.search)]] });
  const result = await run({ platforms: ["reddit"], subreddits: ["r/cscareerquestions"], searches: ["AI hiring"] }, services);
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ["/api/v1/access_token", "/r/cscareerquestions/top", "/search"]);
  assert.ok(calls.slice(1).every((call) => new URL(call.url).searchParams.get("t") === "day"));
  const urls = result.posts.map((post) => post.url);
  assert.ok(urls.includes("https://www.reddit.com/r/cscareerquestions/comments/1gx0a2/offer_letter_automated"), "the thread, not i.redd.it");
  assert.ok(urls.includes("https://www.reddit.com/r/recruitinghell/comments/1gx1b7/recruiter_admitted_ai_screener"));
  assert.equal(urls.filter((url) => url.includes("1gx0a1")).length, 1);
  assert.equal(result.dropped.old, 1);
  assert.equal(source(result, "reddit")?.posts, 3);
});

test("Reddit with an app: a listing's posts, never a longer list inside one post (its awards)", async () => {
  const awarded = structuredClone(reddit.top);
  awarded.data.children[0].data.all_awardings = Array.from({ length: 8 }, (_, index) => ({ id: `award_${index}`, name: "Helpful", count: 1 }));
  const { services } = world({ keys: { reddit: { username: "client-id-123", value: "client-secret-456" } }, routes: [[/access_token/, ok(reddit.token)], [/\/r\/cscareerquestions\/top/, ok(awarded)], [/search/, ok({ kind: "Listing", data: { children: [] } })]] });
  const result = await run({ platforms: ["reddit"], subreddits: ["cscareerquestions"] }, services);
  assert.equal(result.posts.length, 2);
  assert.ok(result.posts.every((post) => post.url.startsWith("https://www.reddit.com/r/cscareerquestions/comments/")));
});

test("Reddit: with an app key, an app-only token from Reddit, sent only to Reddit's API", async () => {
  const { services, calls } = world({
    keys: { reddit: { username: "client-id-123", value: "client-secret-456" } },
    routes: [[/www\.reddit\.com\/api\/v1\/access_token/, ok(reddit.token)], [/oauth\.reddit\.com\/r\/cscareerquestions\/top/, ok(reddit.top)], [/oauth\.reddit\.com\/search/, ok(reddit.search)]],
  });
  const result = await run({ platforms: ["reddit"], subreddits: ["cscareerquestions"] }, services);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers.authorization, `Basic ${Buffer.from("client-id-123:client-secret-456").toString("base64")}`);
  assert.match(calls[0].body ?? "", /grant_type=client_credentials/);
  assert.ok(calls.slice(1).every((call) => call.via === "send" && new URL(call.url).hostname === "oauth.reddit.com" && call.headers.authorization === "Bearer fixture-reddit-access"));
  assert.equal(source(result, "reddit")?.status, "ok");
  assert.ok(!JSON.stringify(result).includes("client-secret-456"));
});

test("RSS: each feed through Perry's internet layer; skipped, and said so, without feeds", async () => {
  const { services, internetCalls } = world({ internet: () => keyed.feed });
  const result = await run({ platforms: ["rss"], feeds: ["https://blog.example.com/feed.xml"] }, services);
  assert.deepEqual(internetCalls.map((request) => [request.operation, "url" in request && request.url]), [["feed", "https://blog.example.com/feed.xml"]]);
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].url, "https://blog.example.com/ai-hiring-report");
  assert.equal(result.dropped.old, 1);
  const none = await run({ platforms: ["rss"] }, world().services);
  assert.equal(source(none, "rss")?.status, "skipped");
  assert.match(none.coverage, /rss skipped \(no feeds given\)/);
});

test("YouTube through the connected account: YouTube's own read-only search for the window, most viewed first", async () => {
  const off = await run({ platforms: ["youtube"] }, world().services);
  assert.equal(source(off, "youtube")?.status, "not_set_up");
  assert.match(source(off, "youtube")?.note ?? "", /Connect YouTube.*no Composio key/);
  const elsewhere = await run({ platforms: ["youtube"] }, world({ connected: { apps: { configured: true, apps: ["gmail"] } } }).services);
  assert.equal(source(elsewhere, "youtube")?.status, "not_set_up");
  assert.match(source(elsewhere, "youtube")?.note ?? "", /^Connect YouTube in Apps & skills/);

  const on = world({ connected: { apps: { configured: true, apps: ["gmail", "youtube"] }, run: () => ({ ok: true, data: youtubeAnswer.search }) } });
  const now = youtubeAnswer._recordedAt;
  const result = await runScroll({ topic: "AI hiring", window: "24h", searches: ["AI hiring", "AI jobs", "AI recruiter"] } as ScrollInput, on.services, { seen: new Set(), now, signal: new AbortController().signal });
  assert.deepEqual(on.connectedCalls.map((call) => call.slug), ["YOUTUBE_SEARCH_YOU_TUBE", "YOUTUBE_SEARCH_YOU_TUBE"], "two searches at most");
  assert.deepEqual(on.connectedCalls[0].args, { q: "AI hiring", part: "snippet", type: "video", order: "viewCount", maxResults: 25, publishedAfter: new Date((now - 86_400) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") });
  const row = source(result, "youtube");
  assert.equal(row?.status, "ok");
  assert.equal(row?.provider, "YouTube (connected account)");
  const videos = result.posts.filter((post) => post.platform === "youtube");
  assert.equal(videos.length, 5);
  assert.equal(videos[0].url, `https://www.youtube.com/watch?v=${youtubeAnswer.search.items[0].id.videoId}`, "YouTube's most viewed first");
  assert.equal(videos[0].author, youtubeAnswer.search.items[0].snippet.channelTitle);
  assert.ok(videos.every((post) => post.likes === undefined && post.views === undefined), "no counts invented");

  const expired = world({ connected: { apps: { configured: true, apps: ["youtube"] }, run: () => ({ ok: false, error: "This account's sign-in expired. Reconnect it in Apps & skills." }) } });
  assert.match(source(await run({ platforms: ["youtube"] }, expired.services), "youtube")?.note ?? "", /reconnecting/);
  const refused = world({ connected: { apps: { configured: true, apps: ["youtube"] }, run: () => ({ ok: false, error: "The connected action could not complete." }) } });
  assert.equal(source(await run({ platforms: ["youtube"] }, refused.services), "youtube")?.status, "failed");
});

test("Lobsters: its hottest and newest stories, only those about the topic and in the window", async () => {
  const now = lobstersAnswer._recordedAt;
  const { services, calls } = world({ routes: [[/lobste\.rs\/hottest\.json/, ok(lobstersAnswer.hottest)], [/lobste\.rs\/newest\.json/, ok(lobstersAnswer.newest)]] });
  const result = await runScroll({ topic: "Lobsters fixture", window: "1w", searches: ["voice assistant", "sorted sets"], platforms: ["lobsters"] } as ScrollInput, services, { seen: new Set(), now, signal: new AbortController().signal });
  assert.deepEqual(calls.map((call) => call.url), ["https://lobste.rs/hottest.json", "https://lobste.rs/newest.json"]);
  assert.ok(calls.every((call) => call.via === "get"));
  const voice = result.posts.find((post) => post.text.startsWith("Rebuilding my local voice assistant pipeline"));
  assert.equal(voice?.url, "https://lobste.rs/s/gn5qb1/rebuilding_my_local_voice_assistant");
  assert.equal(voice?.link, "https://blog.platypush.tech/article/Rewriting-my-voice-assistant-pipeline");
  assert.equal(voice?.author, "blacklight");
  assert.ok(result.posts.some((post) => post.text.includes("Sorted Sets")));
  assert.ok(result.posts.length < lobstersAnswer.hottest.length + lobstersAnswer.newest.length, "off-topic stories are left out");
  const quiet = await runScroll({ topic: "quantum knitting", window: "24h", platforms: ["lobsters"] } as ScrollInput, services, { seen: new Set(), now, signal: new AbortController().signal });
  assert.equal(source(quiet, "lobsters")?.status, "empty");
});

test("Google News: one RSS search per query for the window, the publisher named, its suffix cut from the title", async () => {
  const { services, calls } = world({ routes: [[/news\.google\.com\/rss\/search/, feed(xml("google-news.xml"))]] });
  const now = Math.floor(Date.parse("2026-11-21T00:00:00Z") / 1000);
  const result = await runScroll({ topic: "AI hiring", window: "24h", searches: ["AI hiring", "AI jobs"], platforms: ["news"] } as ScrollInput, services, { seen: new Set(), now, signal: new AbortController().signal });
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0].url).searchParams.get("q"), "AI hiring when:24h");
  const doom = result.posts.find((post) => post.text.startsWith("Hiring is in an"));
  assert.equal(doom?.author, "HR Brew");
  assert.ok(!doom?.text.endsWith("HR Brew"));
  assert.match(doom?.url ?? "", /^https:\/\/news\.google\.com\//);
  assert.equal(source(result, "news")?.posts, 6, "the second search's copies are duplicates");
});

test("Product Hunt without a token: its public feed, only launches about the topic; with one, the API", async () => {
  const body = xml("producthunt-feed.xml");
  const entries = [...body.matchAll(/<title>([^<]+)<\/title>/g)].map((match) => match[1]).slice(1);
  const name = entries[0];
  const { services, calls } = world({ routes: [[/www\.producthunt\.com\/feed/, feed(body)]] });
  const now = Math.floor(Date.parse("2026-11-21T06:00:00Z") / 1000);
  const result = await runScroll({ topic: name, window: "1w", platforms: ["producthunt"] } as ScrollInput, services, { seen: new Set(), now, signal: new AbortController().signal });
  assert.deepEqual(calls.map((call) => call.url), ["https://www.producthunt.com/feed"]);
  assert.equal(source(result, "producthunt")?.provider, "Product Hunt feed");
  assert.ok(result.posts.length >= 1 && result.posts.every((post) => post.text.startsWith(name)), "only the launch the topic names");
  assert.ok(!result.posts[0].text.includes("Discussion"), "the feed's footer is cut");
  const keyedWorld = world({ keys: { producthunt: { value: "ph-token" } }, routes: [[/api\.producthunt\.com/, ok(keyed.producthunt)]] });
  assert.equal(source(await run({ platforms: ["producthunt"] }, keyedWorld.services), "producthunt")?.provider, "Product Hunt");
});

test("keyed platforms without a key are not set up, named with how, and never called", async () => {
  const { services, calls } = world({ routes: [[/hn\.algolia/, ok(hn)]] });
  const result = await run({}, services);
  for (const platform of ["x", "tiktok", "instagram"]) {
    const row = source(result, platform);
    assert.equal(row?.status, "not_set_up", platform);
    assert.match(row?.note ?? "", /Logins & secrets/);
  }
  assert.ok(calls.every((call) => /hn\.algolia\.com|reddit\.com|lobste\.rs|news\.google\.com|producthunt\.com\/feed/.test(call.url)), "only free sources were asked");
  assert.match(result.coverage, /x not set up/);
  assert.match(result.coverage, /tiktok not set up/);
  assert.match(result.coverage, /youtube not set up/);
  assert.doesNotMatch(result.coverage, /producthunt not set up/, "its public feed needs no key");
});

test("X with an API bearer token: one recent search of every query, its metrics and links", async () => {
  const { services, calls } = world({ keys: { x: { value: "x-bearer-secret" } }, routes: [[/api\.x\.com\/2\/tweets\/search\/recent/, ok(keyed.x)]] });
  const result = await run({ platforms: ["x"], searches: ["AI hiring", "AI recruiter"] }, services);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.hostname, "api.x.com");
  assert.equal(calls[0].headers.authorization, "Bearer x-bearer-secret");
  assert.equal(url.searchParams.get("query"), "((AI hiring) OR (AI recruiter)) -is:retweet", "reposts left out of every search");
  assert.equal(url.searchParams.get("start_time"), new Date((NOW - 86_400) * 1000).toISOString());
  const top = result.posts.find((post) => post.url === "https://x.com/hiringlead/status/1859100000000000001");
  assert.deepEqual([top?.likes, top?.comments, top?.shares, top?.views, top?.author], [1800, 96, 250, 240000, "hiringlead"]);
  assert.ok(!JSON.stringify(result).includes("x-bearer-secret"));
});

test("ScrapeCreators: TikTok and Instagram reels, its rows and not a reel's comments", async () => {
  const { services, calls } = world({ keys: { scrapecreators: { value: "sc-key" } }, routes: [[/\/v1\/tiktok\/search\/keyword/, ok(keyed.tiktok)], [/\/v2\/instagram\/reels\/search/, ok(keyed.instagram)]] });
  const result = await run({ platforms: ["tiktok", "instagram"], searches: ["AI hiring"] }, services);
  assert.ok(calls.every((call) => new URL(call.url).hostname === "api.scrapecreators.com" && call.headers["x-api-key"] === "sc-key"));
  assert.equal(new URL(calls.find((call) => call.url.includes("tiktok"))!.url).searchParams.get("date_posted"), "yesterday");
  const clip = result.posts.find((post) => post.platform === "tiktok" && post.views === 1_200_000);
  assert.equal(clip?.url, "https://www.tiktok.com/@jobhunter/video/7439000000000000001");
  assert.equal(result.posts.find((post) => post.platform === "tiktok" && post.views === 40_000)?.url, "https://www.tiktok.com/@resume.tips/video/7439000000000000002");
  const reels = result.posts.filter((post) => post.platform === "instagram");
  assert.equal(reels.length, 1);
  assert.deepEqual([reels[0].url, reels[0].author, reels[0].likes, reels[0].views], ["https://www.instagram.com/reel/DQ1aiHire", "careercoach", 5400, 98000]);
  assert.equal(source(result, "tiktok")?.provider, "ScrapeCreators");
});

test("Product Hunt: the window's launches, only those about the topic", async () => {
  const { services, calls } = world({ keys: { producthunt: { value: "ph-token" } }, routes: [[/api\.producthunt\.com\/v2\/api\/graphql/, ok(keyed.producthunt)]] });
  const result = await run({ platforms: ["producthunt"] }, services);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers.authorization, "Bearer ph-token");
  assert.equal(JSON.parse(calls[0].body ?? "{}").variables.after, new Date((NOW - 86_400) * 1000).toISOString());
  assert.deepEqual(result.posts.map((post) => post.url), ["https://www.producthunt.com/posts/hireloop"]);
  assert.equal(result.posts[0].likes, 412);

  const late = structuredClone(keyed.producthunt);
  late.data.posts.edges[1].node.description = `${"Pick colors faster. ".repeat(30)}Now with AI hiring palettes.`;
  const lateWorld = world({ keys: { producthunt: { value: "ph-token" } }, routes: [[/producthunt/, ok(late)]] });
  assert.equal((await run({ platforms: ["producthunt"] }, lateWorld.services)).posts.length, 2, "matched on the whole launch, not the cut text");

  const refused = world({ keys: { producthunt: { value: "ph-token" } }, routes: [[/producthunt/, ok({ data: null, errors: [{ message: "Field 'posts' is missing required arguments" }] })]] });
  const failed = await run({ platforms: ["producthunt"] }, refused.services);
  assert.equal(source(failed, "producthunt")?.status, "failed", "a GraphQL error is not an empty day");
  assert.match(source(failed, "producthunt")?.note ?? "", /missing required arguments/);
});

test("treg: X through a treg token when there is no X key, with what it cost", async () => {
  const { services, calls } = world({ keys: { treg: { value: "treg-token" } }, routes: [[/treg\.to\/call\/treg\.x\.search\.posts/, ok(keyed.tregX, { "x-treg-cost-micro": "750" })]] });
  const result = await run({ platforms: ["x"] }, services);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["x-treg-token"], "treg-token");
  assert.match(JSON.parse(calls[0].body ?? "{}").q, new RegExp(`since_time:${NOW - 86_400}`));
  assert.equal(result.posts[0].url, "https://x.com/devrel_ana/status/1859100000000000009");
  assert.equal(result.posts[0].via, "treg");
  assert.equal(source(result, "x")?.provider, "treg");
  assert.match(result.coverage, /x 1 via treg/);
  assert.match(result.coverage, /\$0\.00075 on treg/);
  assert.match(calls[0].headers["idempotency-key"], /^[0-9a-f-]{36}$/);

  let tries = 0;
  const dropped = world({ keys: { treg: { value: "treg-token" } }, routes: [[/treg\.to/, () => ++tries === 1 ? new Error("ECONNRESET") : ok(keyed.tregX)]] });
  await run({ platforms: ["x"] }, dropped.services);
  assert.equal(dropped.calls.length, 2);
  assert.equal(dropped.calls[0].headers["idempotency-key"], dropped.calls[1].headers["idempotency-key"], "a retry is a replay, not a second paid search");
});

test("a failing request is tried again once at most, and only for a server failure or no connection", async () => {
  let tries = 0;
  const flaky = world({ routes: [[/hn\.algolia/, () => ++tries === 1 ? status(503) : ok(hn)]] });
  assert.equal(source(await run({ platforms: ["hackernews"] }, flaky.services), "hackernews")?.status, "ok");
  assert.equal(flaky.calls.length, 2);
  const down = world({ routes: [[/hn\.algolia/, status(503)]] });
  const failed = await run({ platforms: ["hackernews"] }, down.services);
  assert.equal(down.calls.length, 2);
  assert.equal(source(failed, "hackernews")?.status, "failed");
  assert.equal(source(failed, "hackernews")?.calls, 2);
  const offline = world({ routes: [[/hn\.algolia/, new Error("ECONNRESET")]] });
  assert.match(source(await run({ platforms: ["hackernews"] }, offline.services), "hackernews")?.note ?? "", /could not connect/);
  assert.equal(offline.calls.length, 2);
  const missing = world({ routes: [[/hn\.algolia/, status(404)]] });
  await run({ platforms: ["hackernews"] }, missing.services);
  assert.equal(missing.calls.length, 1);
  const tooBig = world({ keys: { x: { value: "k" } }, routes: [[/api\.x\.com/, new SourceError("an answer over 5 MB")]] });
  assert.match(source(await run({ platforms: ["x"] }, tooBig.services), "x")?.note ?? "", /over 5 MB/);
  assert.equal(tooBig.calls.length, 1, "refused locally, not sent again");
  const limited = world({ keys: { x: { value: "k" } }, routes: [[/api\.x\.com/, status(429)]] });
  const rate = await run({ platforms: ["x"] }, limited.services);
  assert.equal(limited.calls.length, 1);
  assert.match(source(rate, "x")?.note ?? "", /rate limited/);
});

test("one part failing keeps the rest; a slow source times out without holding up the others", async () => {
  const mixed = world({ keys: { reddit: { username: "client-id-123", value: "client-secret-456" } }, routes: [[/access_token/, ok(reddit.token)], [/\/r\/good\/top/, ok(reddit.top)], [/\/r\/gone\/top/, status(404)], [/oauth\.reddit\.com\/search/, ok(reddit.search)]] });
  const result = await run({ platforms: ["reddit"], subreddits: ["gone", "good"] }, mixed.services);
  assert.equal(source(result, "reddit")?.status, "ok");
  assert.match(source(result, "reddit")?.note ?? "", /r\/gone: HTTP 404/);
  const slow = world({ routes: [[/hn\.algolia/, () => new Promise<Http>(() => {})], [/reddit/, feed(xml("reddit-top.xml"))]] });
  const started = Date.now();
  const timed = await run({ platforms: ["hackernews", "reddit"], subreddits: ["cscareerquestions"] }, slow.services, new Set(), 300);
  assert.ok(Date.now() - started < 3000);
  assert.equal(source(timed, "hackernews")?.status, "failed");
  assert.match(source(timed, "hackernews")?.note ?? "", /timed out/);
  assert.equal(source(timed, "reddit")?.status, "ok");
});

test("the coverage line, the dropped counts, and a repeat run returning only what is new", async () => {
  const { services } = world({ keys: { reddit: { username: "client-id-123", value: "client-secret-456" } }, routes: [[/hn\.algolia/, ok(hn)], [/access_token/, ok(reddit.token)], [/reddit\.com\/r\//, ok(reddit.top)], [/reddit\.com\/search/, ok(reddit.search)]] });
  const first = await run({ platforms: ["hackernews", "reddit"], subreddits: ["cscareerquestions"], limit: 3 }, services);
  assert.equal(first.posts.length, 3);
  assert.equal(first.nothingNew, false);
  assert.match(first.coverage, /^hackernews 3 · reddit 3 · \d+ duplicates?, 1 too old, 0 already seen$/);
  const seen = new Set(first.shownKeys);
  const second = await run({ platforms: ["hackernews", "reddit"], subreddits: ["cscareerquestions"], limit: 3 }, services, seen);
  assert.equal(second.posts.length, 3);
  assert.ok(second.posts.every((post) => !seen.has(post.url)));
  assert.match(second.coverage, /3 already seen$/);
  for (const key of second.shownKeys) seen.add(key);
  const third = await run({ platforms: ["hackernews", "reddit"], subreddits: ["cscareerquestions"], limit: 3 }, services, seen);
  assert.equal(third.posts.length, 0);
  assert.equal(third.nothingNew, true);
  const again = await run({ platforms: ["hackernews", "reddit"], subreddits: ["cscareerquestions"], limit: 3, includeSeen: true }, services, seen);
  assert.equal(again.posts.length, 3, "asked to, it shows them again");
  assert.equal(again.nothingNew, false, "showing them again is not 'nothing new'");
});

test("a run where no platform answered is not 'nothing new'", async () => {
  const down = world({ keys: { x: { value: "k" } }, routes: [[/api\.x\.com/, status(401)], [/hn\.algolia/, status(503)]] });
  const result = await run({ platforms: ["x", "hackernews", "tiktok"] }, down.services);
  assert.equal(result.posts.length, 0);
  assert.equal(result.nothingNew, false);
  assert.equal(result.noSource, true);
  const quiet = world({ routes: [[/hn\.algolia/, ok({ hits: [] })]] });
  const empty = await run({ platforms: ["hackernews", "x"] }, quiet.services);
  assert.equal(empty.nothingNew, true, "one platform answered with nothing: a quiet day");
  assert.equal(empty.noSource, false);
});
