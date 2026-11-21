import { epoch, rowsOf } from "../merge";
import { fresh, NotSetUp, parts, plain, SourceError, type Source } from "../types";

const SEARCH = "YOUTUBE_SEARCH_YOU_TUBE";
const CONNECT = "Connect YouTube in Apps & skills → Connectors";

/**
 * YouTube through the owner's connected YouTube account, the way run_action
 * reaches it: YouTube's own search, read-only, for videos published in the
 * window, most viewed first. Its answer carries no counts, so its order breaks
 * ties within YouTube.
 */
export const youtube: Source = {
  name: "YouTube (connected account)",
  platforms: ["youtube"],
  async fetch(_platform, plan, services, signal) {
    const fetched = fresh();
    const apps = await services.connected.apps();
    if (!apps.configured) throw new NotSetUp(`${CONNECT} (Perry has no Composio key yet)`);
    if (apps.error) throw new SourceError(`could not check the connected apps: ${plain(apps.error, 120)}`);
    if (!apps.apps.includes("youtube")) throw new NotSetUp(CONNECT);
    const publishedAfter = new Date((plan.now - plan.span) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    return await parts(fetched, plan.searches.slice(0, 2), (search) => `"${search}"`, async (search) => {
      const reply = await services.connected.run(SEARCH, { q: search, part: "snippet", type: "video", order: "viewCount", maxResults: 25, publishedAfter });
      if (!reply.ok) {
        if (/reconnect|expired|revoked/i.test(reply.error ?? "")) throw new NotSetUp("the connected YouTube account needs reconnecting in Apps & skills → Connectors");
        throw new SourceError(plain(reply.error ?? "the connected search failed", 160).replace(/\.$/, ""));
      }
      const rows = rowsOf(reply.data);
      return rows.flatMap((row, index) => {
        const id = row.id && typeof row.id === "object" ? (row.id as Record<string, unknown>).videoId : row.videoId ?? row.video_id;
        const snippet = (row.snippet && typeof row.snippet === "object" ? row.snippet : row) as Record<string, unknown>;
        if (typeof id !== "string") return [];
        // No counts: YouTube's own most-viewed order stands in for them within YouTube.
        return [{ source: "youtube", url: `https://www.youtube.com/watch?v=${id}`, text: plain([snippet.title, snippet.description].filter(Boolean).join(". ")),
          author: typeof snippet.channelTitle === "string" ? snippet.channelTitle : null, created: epoch(snippet.publishedAt, plan.now), views: 0, likes: 0, comments: 0, shares: 0, position: index + 1 }];
      });
    }, { signal });
  },
};
