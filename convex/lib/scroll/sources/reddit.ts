import { feedItems } from "../../internet";
import { epoch, item } from "../merge";
import { attempt, fresh, json, parts, plain, query, SourceError, text, type Fetched, type Plan, type Services, type Source } from "../types";

const NAME = /^[A-Za-z0-9_]{2,21}$/;
const AGENT = "perry-scroll/1.0 (+https://github.com/TheM1N9/perry)";
const APP_HINT = 'a free Reddit app saved as "Reddit app" in Settings → Logins & secrets reads through its API';

/**
 * Reddit: the named subreddits' top posts in the window, or a keyword search
 * (loose, it pulls in unrelated threads; the judging drops them).
 *
 * With no key, Reddit's public RSS, with a User-Agent that says who is asking.
 * Reddit allows an anonymous reader about one request a minute, so a run makes
 * one: every subreddit in a single multireddit feed, or else one search. Its
 * feeds carry no scores. An owner's Reddit app (free to make) reads through
 * Reddit's API instead, with scores, a request per subreddit and a search.
 */
export const reddit: Source = {
  name: "Reddit",
  platforms: ["reddit"],
  async fetch(_platform, plan, services, signal) {
    const t = plan.span <= 86_400 ? "day" : plan.span <= 604_800 ? "week" : "month";
    const subreddits = [...new Set(plan.subreddits.map((name) => name.trim().replace(/^\/?r\//i, "")).filter((name) => NAME.test(name)))].slice(0, 6);
    return services.keys.reddit?.username ? await viaApp(plan, services, signal, subreddits, t) : await viaFeed(plan, services, signal, subreddits, t);
  },
};

async function viaFeed(plan: Plan, services: Services, signal: AbortSignal, subreddits: string[], t: string): Promise<Fetched> {
  const fetched = fresh();
  const url = subreddits.length
    ? `https://www.reddit.com/r/${subreddits.join("+")}/top.rss?${query({ t, limit: 50 })}`
    : `https://www.reddit.com/search.rss?${query({ q: plan.searches[0] ?? plan.topic, sort: "top", t, limit: 50 })}`;
  let body: string;
  try {
    // Asked once, never again in the same run: a retry would spend the next minute's allowance.
    body = text(await services.send(url, { method: "GET", headers: { "user-agent": AGENT, accept: "application/atom+xml, application/rss+xml" } }, signal));
  } catch (error) {
    // Reddit answers an anonymous reader it will not serve with an empty "Not Found" feed, or a 403 or 429.
    if (error instanceof SourceError && /404|refused|rate limited/.test(error.message)) throw new SourceError(`${error.message.replace("Not Found (HTTP 404)", "Not Found, HTTP 404")} from its public feed, as Reddit answers anonymous readers on some networks; ${APP_HINT}`);
    throw error;
  }
  if (/<title>\s*Not Found\s*<\/title>/i.test(body) && !/<entry[\s>]/i.test(body)) throw new SourceError(`Not Found from its public feed, as Reddit answers anonymous readers on some networks; ${APP_HINT}`);
  let entries: ReturnType<typeof feedItems>;
  try { entries = feedItems(body, url, 50); } catch { throw new SourceError("its public feed was not readable"); }
  fetched.posts = entries.map((entry) => ({
    // The post's own text comes before Reddit's "submitted by ... [link] [comments]" footer.
    source: "reddit", url: (entry.url ?? "").replace(/\/+$/, ""), text: plain([entry.title, entry.content.split(/\bsubmitted by\b/)[0].replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")].filter(Boolean).join(". ")),
    // An Atom author is its name and its profile link run together: the name, without /u/.
    author: entry.author?.replace(/https?:\/\/\S*/g, " ").trim().split(/\s+/)[0]?.replace(/^\/?u\//, "") || null, created: epoch(entry.publishedAt ?? entry.updatedAt, plan.now), views: 0, likes: 0, comments: 0, shares: 0,
  }));
  if (subreddits.length && plan.searches.length) fetched.notes.push("feed only: no keyword search, to stay inside Reddit's one request a minute for anonymous readers");
  return fetched;
}

async function viaApp(plan: Plan, services: Services, signal: AbortSignal, subreddits: string[], t: string): Promise<Fetched> {
  const fetched = fresh();
  const app = services.keys.reddit!;
  const token = json(await attempt(() => services.send("https://www.reddit.com/api/v1/access_token", {
    method: "POST", body: "grant_type=client_credentials",
    headers: { authorization: `Basic ${Buffer.from(`${app.username}:${app.value}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded", "user-agent": AGENT },
  }, signal), signal)) as { access_token?: string };
  if (!token.access_token) throw new SourceError("Reddit gave the app no token");
  const asks = [
    ...subreddits.map((name) => ({ label: `r/${name}`, path: `/r/${name}/top`, params: { t, limit: 25 } })),
    ...plan.searches.slice(0, 2).map((search) => ({ label: `search "${search}"`, path: "/search", params: { q: search, sort: "top", t, limit: 25 } })),
  ];
  // One host: asked one at a time, and not asked again once it refuses.
  return await parts(fetched, asks, (ask) => ask.label, async (ask) => {
    const reply = await attempt(() => services.send(`https://oauth.reddit.com${ask.path}?${query({ ...ask.params, raw_json: 1 })}`, { method: "GET", headers: { authorization: `Bearer ${token.access_token}`, "user-agent": AGENT } }, signal), signal);
    // A listing's posts are its data.children, never another list inside a post (its awards).
    const listing = json(reply) as { data?: { children?: Array<{ data?: Record<string, unknown> }> } };
    return (listing.data?.children ?? []).flatMap((child) => child.data ? [{ ...item("reddit", child.data, plan.now), text: plain([child.data.title, child.data.selftext].filter(Boolean).join(". ")) }] : []);
  }, { sequential: true, signal });
}
