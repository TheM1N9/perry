import { epoch, num } from "../merge";
import { attempt, fresh, json, plain, query, type Source } from "../types";

/** X's own API, recent search, with the owner's bearer token: every query in one search, reposts left out. */
export const xApi: Source = {
  name: "X API",
  platforms: ["x"],
  key: "x",
  async fetch(_platform, plan, services, signal) {
    const fetched = fresh();
    let terms = "";
    for (const search of plan.searches) {
      const next = `${terms ? `${terms} OR ` : ""}(${search})`;
      if (next.length > 480) break;
      terms = next;
    }
    // Recent search covers seven days; start a minute inside that for a week's window.
    const start = new Date(Math.max(plan.now - plan.span, plan.now - 604_740) * 1000).toISOString();
    const url = `https://api.x.com/2/tweets/search/recent?${query({
      query: `${terms} -is:retweet`, start_time: start, max_results: 100, sort_order: "relevancy",
      "tweet.fields": "created_at,public_metrics,author_id", expansions: "author_id", "user.fields": "username",
    })}`;
    const body = json(await attempt(() => services.send(url, { method: "GET", headers: { authorization: `Bearer ${services.keys.x!.value}` } }, signal), signal)) as {
      data?: Array<{ id: string; text: string; created_at?: string; author_id?: string; public_metrics?: Record<string, number> }>;
      includes?: { users?: Array<{ id: string; username: string }> };
    };
    const names = new Map((body.includes?.users ?? []).map((user) => [user.id, user.username]));
    fetched.posts = (body.data ?? []).map((tweet) => {
      const author = tweet.author_id ? names.get(tweet.author_id) : undefined;
      const metrics = tweet.public_metrics ?? {};
      return {
        source: "x", url: `https://x.com/${author ?? "i/web"}/status/${tweet.id}`, text: plain(tweet.text, 600), author: author ?? null,
        created: epoch(tweet.created_at, plan.now), views: num(metrics.impression_count), likes: num(metrics.like_count),
        comments: num(metrics.reply_count), shares: num(metrics.retweet_count) + num(metrics.quote_count),
      };
    });
    return fetched;
  },
};
