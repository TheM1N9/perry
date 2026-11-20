import { item } from "../merge";
import { attempt, fresh, json, parts, plain, query, SourceError, type Http, type Source } from "../types";

const NAME = /^[A-Za-z0-9_]{2,21}$/;
const AGENT = "perry-scroll/1.0 (+https://github.com/TheM1N9/perry)";

/**
 * Reddit: each named subreddit's top posts in the window, and a keyword search
 * (loose, it pulls in unrelated threads; the judging drops them). Free over
 * Reddit's public JSON, which Reddit turns away from some networks; an owner's
 * Reddit app (free to make) reads through Reddit's API instead.
 */
export const reddit: Source = {
  name: "Reddit",
  platforms: ["reddit"],
  async fetch(_platform, plan, services, signal) {
    const fetched = fresh();
    const app = services.keys.reddit;
    let read: (path: string, params: Record<string, string | number>) => Promise<Http>;
    if (app?.username) {
      const token = json(await attempt(() => services.send("https://www.reddit.com/api/v1/access_token", {
        method: "POST", body: "grant_type=client_credentials",
        headers: { authorization: `Basic ${Buffer.from(`${app.username}:${app.value}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded", "user-agent": AGENT },
      }, signal), signal)) as { access_token?: string };
      if (!token.access_token) throw new SourceError("Reddit gave the app no token");
      read = (path, params) => services.send(`https://oauth.reddit.com${path}?${query({ ...params, raw_json: 1 })}`, { method: "GET", headers: { authorization: `Bearer ${token.access_token}`, "user-agent": AGENT } }, signal);
    } else {
      read = (path, params) => services.get(`https://www.reddit.com${path}.json?${query({ ...params, raw_json: 1 })}`, signal);
    }
    const t = plan.span <= 86_400 ? "day" : plan.span <= 604_800 ? "week" : "month";
    const subreddits = [...new Set(plan.subreddits.map((name) => name.trim().replace(/^\/?r\//i, "")).filter((name) => NAME.test(name)))].slice(0, 6);
    const asks = [
      ...subreddits.map((name) => ({ label: `r/${name}`, path: `/r/${name}/top`, params: { t, limit: 25 } })),
      ...plan.searches.slice(0, 2).map((search) => ({ label: `search "${search}"`, path: "/search", params: { q: search, sort: "top", t, limit: 25 } })),
    ];
    try {
      // One host: asked one at a time, and not asked again once it refuses.
      return await parts(fetched, asks, (ask) => ask.label, async (ask) => {
        // A listing's posts are its data.children, never another list inside a post (its awards).
        const listing = json(await attempt(() => read(ask.path, ask.params), signal)) as { data?: { children?: Array<{ data?: Record<string, unknown> }> } };
        return (listing.data?.children ?? []).flatMap((child) => child.data ? [{ ...item("reddit", child.data, plan.now), text: plain([child.data.title, child.data.selftext].filter(Boolean).join(". ")) }] : []);
      }, { sequential: true, signal });
    } catch (error) {
      if (!app && error instanceof SourceError && /refused|rate limited/.test(error.message)) {
        throw new SourceError(`${error.message}; Reddit turns away anonymous reads from some networks. A free Reddit app saved as "Reddit app" in Settings → Logins & secrets reads through its API`);
      }
      throw error;
    }
  },
};
