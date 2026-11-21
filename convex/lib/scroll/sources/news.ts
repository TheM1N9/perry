import { epoch } from "../merge";
import { fresh, parts, plain, query, SourceError, type Source } from "../types";

/**
 * News coverage through Google News's public RSS search, one feed per search,
 * limited to the window. A title ends with its publisher ("... - Fortune"),
 * which is kept as the post's author.
 */
export const news: Source = {
  name: "Google News",
  platforms: ["news"],
  async fetch(_platform, plan, services, signal) {
    const fetched = fresh();
    const when = plan.span <= 86_400 ? `${Math.round(plan.span / 3600)}h` : `${Math.round(plan.span / 86_400)}d`;
    return await parts(fetched, plan.searches.slice(0, 3), (search) => `"${search}"`, async (search) => {
      const url = `https://news.google.com/rss/search?${query({ q: `${search} when:${when}`, hl: "en-US", gl: "US", ceid: "US:en" })}`;
      const result = await services.internet({ operation: "feed", url, limit: 20 }, signal);
      if (result.error || !["ok", "partial", "empty"].includes(result.status)) throw new SourceError(result.error?.message.replace(/\.$/, "").toLowerCase() ?? result.status);
      return result.items.map((entry) => {
        const title = plain(entry.title ?? "");
        const cut = title.lastIndexOf(" - ");
        return { source: "news", url: entry.url ?? "", text: cut > 0 ? title.slice(0, cut) : title, author: cut > 0 ? title.slice(cut + 3) : entry.author ?? null,
          created: epoch(entry.publishedAt ?? entry.updatedAt, plan.now), views: 0, likes: 0, comments: 0, shares: 0 };
      });
    }, { signal });
  },
};
