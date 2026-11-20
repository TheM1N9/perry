import { randomUUID } from "node:crypto";
import { item, rowsOf } from "../merge";
import { attempt, fresh, json, parts, type Platform, type Source } from "../types";

/**
 * treg's routed searches (https://treg.to), with the owner's treg token: X,
 * TikTok, Instagram reels and YouTube, each answered by whichever provider treg
 * picks, at treg's price per call. Used for a platform with no key of its own.
 */
const TOOLS: Partial<Record<Platform, { id: string; rows: string; searches: number; body: (search: string, since: number) => Record<string, unknown> }>> = {
  // X's search syntax goes inside the query: the window and a floor of likes.
  x: { id: "treg.x.search.posts", rows: "posts", searches: 1, body: (search, since) => ({ q: `${search} since_time:${since} min_faves:20 -filter:retweets`, limit: 40 }) },
  tiktok: { id: "treg.tiktok.search.videos", rows: "videos", searches: 2, body: (search) => ({ query: search, limit: 30 }) },
  instagram: { id: "treg.instagram.search.reels", rows: "reels", searches: 2, body: (search) => ({ query: search, limit: 30 }) },
  youtube: { id: "treg.youtube.search.videos", rows: "videos", searches: 2, body: (search) => ({ query: search, limit: 30 }) },
};

export const treg: Source = {
  name: "treg",
  platforms: ["x", "tiktok", "instagram", "youtube"],
  key: "treg",
  async fetch(platform, plan, services, signal) {
    const fetched = fresh();
    const tool = TOOLS[platform]!;
    const searches = platform === "x" ? [plan.searches.map((search) => `(${search})`).join(" OR ")] : plan.searches.slice(0, tool.searches);
    return await parts(fetched, searches, (search) => `"${search}"`, async (search) => {
      // One key per search, the same on its retry: treg answers a replay from what it stored, without charging again.
      const idempotency = randomUUID();
      const reply = await attempt(() => services.send(`https://treg.to/call/${tool.id}`, {
        method: "POST", body: JSON.stringify(tool.body(search, plan.now - plan.span)),
        headers: { "x-treg-token": services.keys.treg!.value, "content-type": "application/json", "x-treg-route-max-cost": "0.05", "idempotency-key": idempotency },
      }, signal), signal);
      const body = json(reply) as { output?: Record<string, unknown>; _treg?: { charged_micro?: number } };
      const cost = Number(reply.headers["x-treg-cost-micro"] ?? body._treg?.charged_micro ?? 0);
      if (Number.isFinite(cost) && cost > 0) fetched.costMicro = (fetched.costMicro ?? 0) + cost;
      const listed = body.output?.[tool.rows];
      const rows = Array.isArray(listed) ? listed.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object").map((row) => (row.aweme_info ?? row) as Record<string, unknown>) : rowsOf(body);
      return rows.map((row) => ({ ...item(platform, row, plan.now), via: "treg" }));
    }, { signal });
  },
};
