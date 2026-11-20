import { item, type Post } from "../merge";
import { attempt, fresh, json, parts, query, type Platform, type Source } from "../types";

/** TikTok keyword search and Instagram reels search through ScrapeCreators, with the owner's API key. */
export const scrapecreators: Source = {
  name: "ScrapeCreators",
  platforms: ["tiktok", "instagram"],
  key: "scrapecreators",
  async fetch(platform: Platform, plan, services, signal) {
    const fetched = fresh();
    const headers = { "x-api-key": services.keys.scrapecreators!.value };
    const read = async (path: string, params: Record<string, string>) =>
      json(await attempt(() => services.send(`https://api.scrapecreators.com${path}?${query(params)}`, { method: "GET", headers }, signal), signal)) as Record<string, unknown>;
    if (platform === "tiktok") {
      return await parts(fetched, plan.searches.slice(0, 3), (search) => `"${search}"`, async (search) => {
        const body = await read("/v1/tiktok/search/keyword", { query: search, date_posted: plan.span <= 86_400 ? "yesterday" : "this-week", sort_by: "relevance" });
        const list = Array.isArray(body.search_item_list) ? body.search_item_list as Array<Record<string, unknown>> : [];
        return list.map((entry) => (entry.aweme_info ?? entry) as Record<string, unknown>).map((video): Post => {
          const post = item("tiktok", video, plan.now);
          const author = video.author as { unique_id?: string } | undefined;
          return post.url || !author?.unique_id ? post : { ...post, url: `https://www.tiktok.com/@${author.unique_id}/video/${video.aweme_id}` };
        });
      }, { signal });
    }
    // Reels only: a reel carries its comments, which are not posts of their own.
    return await parts(fetched, plan.searches.slice(0, 2), (search) => `"${search}"`, async (search) => {
      const body = await read("/v2/instagram/reels/search", { query: search, date_posted: "last-week" });
      return (Array.isArray(body.reels) ? body.reels as Array<Record<string, unknown>> : []).map((reel) => item("instagram", reel, plan.now));
    }, { signal });
  },
};
