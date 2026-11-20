import { epoch, num } from "../merge";
import { attempt, fresh, json, plain, SourceError, type Source } from "../types";

const LAUNCHES = `query Launches($after: DateTime!) {
  posts(first: 40, order: VOTES, postedAfter: $after) {
    edges { node { id name tagline description url votesCount commentsCount createdAt website topics(first: 5) { edges { node { name } } } } }
  }
}`;
const FILLER = new Set(["the", "and", "for", "with", "about", "from", "what", "how", "new", "launch", "launches", "launched", "people", "posting"]);

/**
 * Product Hunt's launches in the window, with the owner's developer token. Its
 * API has no search, so the day's launches are kept only when they name a word
 * of the topic or a search.
 */
export const producthunt: Source = {
  name: "Product Hunt",
  platforms: ["producthunt"],
  key: "producthunt",
  async fetch(_platform, plan, services, signal) {
    const fetched = fresh();
    const body = json(await attempt(() => services.send("https://api.producthunt.com/v2/api/graphql", {
      method: "POST", headers: { authorization: `Bearer ${services.keys.producthunt!.value}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query: LAUNCHES, variables: { after: new Date((plan.now - plan.span) * 1000).toISOString() } }),
    }, signal), signal)) as { data?: { posts?: { edges?: Array<{ node: Record<string, unknown> }> } } | null; errors?: Array<{ message?: string }> };
    // GraphQL reports its errors beside the data, with HTTP 200.
    const edges = body.data?.posts?.edges;
    const error = body.errors?.[0]?.message;
    if (error && !edges?.length) throw new SourceError(`Product Hunt said: ${plain(error, 160)}`);
    if (error) fetched.notes.push(`Product Hunt said: ${plain(error, 160)}`);
    const words = [...new Set([plan.topic, ...plan.searches].join(" ").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].filter((word) => !FILLER.has(word));
    const about = (text: string) => words.some((word) => new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}\\p{N}]|$)`, "iu").test(text));
    fetched.posts = (edges ?? []).map(({ node }) => node).flatMap((node) => {
      const topics = ((node.topics as { edges?: Array<{ node: { name: string } }> } | undefined)?.edges ?? []).map((edge) => edge.node.name);
      // Matched on the whole launch, cut only for what is returned.
      const whole = plain(`${node.name}: ${node.tagline}. ${node.description ?? ""}`, Infinity);
      if (!about(`${whole} ${topics.join(" ")}`)) return [];
      const text = plain(whole);
      return [{ source: "producthunt", url: String(node.url ?? ""), ...(typeof node.website === "string" ? { link: node.website } : {}), text, author: null,
        created: epoch(node.createdAt, plan.now), views: 0, likes: num(node.votesCount), comments: num(node.commentsCount), shares: 0 }];
    });
    return fetched;
  },
};
