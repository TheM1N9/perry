import { epoch, rowsOf } from "../merge";
import { fresh, NotSetUp, parts, plain, SourceError, type Source } from "../types";

/**
 * YouTube through the owner's connected YouTube account (Apps & skills →
 * Connectors), over Perry's connected-read path: the search operation is
 * discovered, never guessed, and given only the arguments its schema takes.
 */
export const youtube: Source = {
  name: "YouTube (connected account)",
  platforms: ["youtube"],
  async fetch(_platform, plan, services, signal) {
    const fetched = fresh();
    const found = await services.internet({ operation: "search", platform: "youtube", query: plan.searches[0] ?? plan.topic, limit: 20 }, signal);
    const discovery = found.discovery;
    if (!discovery || discovery.state === "setup_required") throw new NotSetUp("Connect YouTube in Apps & skills → Connectors");
    if (discovery.state === "expired_auth") throw new NotSetUp("the connected YouTube account needs reconnecting in Apps & skills → Connectors");
    const active = discovery.accounts.filter((account) => account.status === "ACTIVE");
    if (!active.length) throw new NotSetUp("Connect YouTube in Apps & skills → Connectors");
    const account = plan.youtubeAccount ? active.find((candidate) => candidate.id === plan.youtubeAccount) : active.length === 1 ? active[0] : undefined;
    if (!account) throw new SourceError(plan.youtubeAccount ? "that YouTube account is not connected" : `${active.length} YouTube accounts are connected; pass youtubeAccount (${active.map((a) => a.id).join(", ")})`);
    const action = discovery.actions.find((candidate) => /YOUTUBE/i.test(candidate.slug) && /SEARCH/i.test(candidate.slug));
    if (!action) throw new SourceError("no YouTube search operation was found for the connected account");
    const properties = Object.keys((action.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {});
    const term = properties.find((key) => /^(q|query|search_?query|keyword)$/i.test(key));
    if (!term) throw new SourceError("the connected YouTube search takes no search words");
    const since = new Date((plan.now - plan.span) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const extra: Record<string, unknown> = { part: "snippet", type: "video", maxResults: 20, max_results: 20, publishedAfter: since, published_after: since, order: "viewCount" };
    return await parts(fetched, plan.searches.slice(0, 2), (search) => `"${search}"`, async (search) => {
      const args: Record<string, unknown> = { [term]: search };
      for (const key of properties) if (key in extra && !(key in args)) args[key] = extra[key];
      const result = await services.internet({ operation: "search", platform: "youtube", query: search, limit: 20, connector: { accountId: account.id, slug: action.slug, args } }, signal);
      if (result.error) throw new SourceError(result.error.message.replace(/\.$/, "").toLowerCase());
      const data = result.items[0]?.content;
      if (!data) return [];
      return rowsOf(JSON.parse(data)).flatMap((row) => {
        const id = row.id && typeof row.id === "object" ? (row.id as Record<string, unknown>).videoId : row.videoId ?? row.video_id;
        const snippet = (row.snippet && typeof row.snippet === "object" ? row.snippet : row) as Record<string, unknown>;
        if (typeof id !== "string") return [];
        return [{ source: "youtube", url: `https://www.youtube.com/watch?v=${id}`, text: plain([snippet.title, snippet.description].filter(Boolean).join(". ")),
          author: typeof snippet.channelTitle === "string" ? snippet.channelTitle : null, created: epoch(snippet.publishedAt, plan.now), views: 0, likes: 0, comments: 0, shares: 0 }];
      });
    }, { signal });
  },
};
