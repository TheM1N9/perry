import { epoch, num } from "../merge";
import { aboutTopic, attempt, fresh, json, plain, SourceError, type Source } from "../types";

const LAUNCHES = `query Launches($after: DateTime!) {
  posts(first: 40, order: VOTES, postedAfter: $after) {
    edges { node { id name tagline description url votesCount commentsCount createdAt website topics(first: 5) { edges { node { name } } } } }
  }
}`;

/**
 * Product Hunt's launches in the window, with the owner's developer token. Its
 * API has no search, so the window's launches are kept only when they are about
 * the topic (aboutTopic).
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
    const about = aboutTopic(plan);
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


/**
 * Product Hunt's public Atom feed of featured launches, free: no votes or
 * comment counts, and a launch's date is when it was posted. Kept when it is
 * about the topic and inside the window. A developer token reads the API instead.
 */
export const producthuntFeed: Source = {
  name: "Product Hunt feed",
  platforms: ["producthunt"],
  async fetch(_platform, plan, services, signal) {
    const fetched = fresh();
    const result = await services.internet({ operation: "feed", url: "https://www.producthunt.com/feed", limit: 20 }, signal);
    if (result.error || !["ok", "partial", "empty"].includes(result.status)) throw new SourceError(result.error?.message.replace(/\.$/, "").toLowerCase() ?? result.status);
    const about = aboutTopic(plan);
    fetched.posts = result.items.flatMap((entry) => {
      // A launch's tagline, without the feed's "Discussion | Link" footer.
      const tagline = plain(entry.content.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\bDiscussion\b\s*\|\s*\bLink\b/g, ""), Infinity);
      const whole = plain([entry.title, tagline].filter(Boolean).join(": "), Infinity);
      if (!about(whole) || !entry.url) return [];
      return [{ source: "producthunt", url: entry.url, text: plain(whole), author: entry.author ?? null,
        created: epoch(entry.publishedAt ?? entry.updatedAt, plan.now), views: 0, likes: 0, comments: 0, shares: 0 }];
    });
    if (!fetched.posts.length && result.items.length) fetched.notes.push(`none of its ${result.items.length} latest launches is about the topic`);
    return fetched;
  },
};
