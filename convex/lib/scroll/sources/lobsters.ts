import { epoch, num } from "../merge";
import { aboutTopic, attempt, fresh, json, parts, plain, type Source } from "../types";

/**
 * Lobsters (lobste.rs): its hottest and newest stories, free and public. It has
 * no search to ask, so a story is kept when it is about the topic.
 */
export const lobsters: Source = {
  name: "Lobsters",
  platforms: ["lobsters"],
  async fetch(_platform, plan, services, signal) {
    const fetched = fresh();
    const about = aboutTopic(plan);
    let read = 0;
    const done = await parts(fetched, ["hottest", "newest"], (page) => page, async (page) => {
      const stories = json(await attempt(() => services.get(`https://lobste.rs/${page}.json`, signal), signal));
      const list = Array.isArray(stories) ? stories as Array<Record<string, unknown>> : [];
      read += list.length;
      return list.flatMap((story) => {
        const tags = Array.isArray(story.tags) ? story.tags.join(" ") : "";
        if (!about(`${story.title} ${tags} ${story.description_plain ?? ""}`) || typeof story.comments_url !== "string") return [];
        return [{ source: "lobsters", url: story.comments_url, ...(typeof story.url === "string" && story.url ? { link: story.url } : {}),
          text: plain([story.title, story.description_plain].filter(Boolean).join(". ")), author: typeof story.submitter_user === "string" ? story.submitter_user : null,
          created: epoch(story.created_at, plan.now), views: 0, likes: num(story.score), comments: num(story.comment_count), shares: 0 }];
      });
    }, { signal });
    if (!done.posts.length && read) done.notes.push(`none of its ${read} latest stories is about the topic`);
    return done;
  },
};
