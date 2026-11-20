import { epoch } from "../merge";
import { fresh, parts, plain, SourceError, type Source } from "../types";

/** RSS and Atom feeds the agent names for the topic (a company blog, a newsletter), read by Perry's internet layer. */
export const rss: Source = {
  name: "RSS",
  platforms: ["rss"],
  async fetch(_platform, plan, services, signal) {
    const fetched = fresh();
    return await parts(fetched, plan.feeds.slice(0, 10), (feed) => { try { return new URL(feed).hostname; } catch { return feed; } }, async (url) => {
      const result = await services.internet({ operation: "feed", url, limit: 20 }, signal);
      if (result.error || !["ok", "partial", "empty"].includes(result.status)) throw new SourceError(result.error?.message.replace(/\.$/, "").toLowerCase() ?? result.status);
      return result.items.map((entry) => {
        const title = plain(entry.title ?? "");
        // Link markup out; a summary that only repeats the title (news aggregators) adds nothing.
        const summary = plain(entry.content.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1"));
        const squash = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
        const repeats = summary.length < title.length + 80 && squash(summary).startsWith(squash(title).slice(0, 40));
        return {
          source: "rss", url: entry.url ?? "", text: plain([title, repeats ? "" : summary].filter(Boolean).join(". ")), author: entry.author ?? null,
          created: epoch(entry.publishedAt ?? entry.updatedAt, plan.now), views: 0, likes: 0, comments: 0, shares: 0,
        };
      });
    }, { signal });
  },
};
