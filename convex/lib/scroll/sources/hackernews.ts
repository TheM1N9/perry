import { epoch, num } from "../merge";
import { attempt, fresh, json, parts, plain, query, type Source } from "../types";

/** Hacker News through Algolia's public search: free, no key. One search per query, stories only, inside the window. */
export const hackernews: Source = {
  name: "Hacker News",
  platforms: ["hackernews"],
  async fetch(_platform, plan, services, signal) {
    const fetched = fresh();
    return await parts(fetched, plan.searches.slice(0, 4), (search) => `"${search}"`, async (search) => {
      const url = `https://hn.algolia.com/api/v1/search?${query({ query: search, tags: "story", numericFilters: `created_at_i>${plan.now - plan.span}`, hitsPerPage: 30 })}`;
      const body = json(await attempt(() => services.get(url, signal), signal)) as { hits?: Array<Record<string, unknown>> };
      return (body.hits ?? []).flatMap((hit) => typeof hit.objectID !== "string" ? [] : [{
        source: "hackernews", url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
        ...(typeof hit.url === "string" && hit.url ? { link: hit.url } : {}),
        text: plain([hit.title, hit.story_text].filter(Boolean).join(". ")),
        author: typeof hit.author === "string" ? hit.author : null, created: epoch(hit.created_at_i ?? hit.created_at, plan.now),
        views: 0, likes: num(hit.points), comments: num(hit.num_comments), shares: 0,
      }]);
    }, { signal });
  },
};
