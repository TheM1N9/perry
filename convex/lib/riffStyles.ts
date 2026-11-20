/**
 * Riff's core styles. A style is a skill: a SKILL.md with a name, a
 * description and a body that tells Perry how to write. These three ship with
 * Perry; a skill in the owner's skills folder is offered beside them (riff.ts)
 * when its frontmatter says `riff: true`, so a private style never needs to be
 * in this repository and other skills stay out of the picker. A skill of a core
 * style's name, with the flag, takes that style's place. See docs/riff-styles.md.
 *
 * Frontmatter Riff reads:
 *   riff: true             offered as a writing style in Riff
 *   riff-post-limit: 280   the most characters in one post, posts being separated by a line of `---`
 */

export const CORE_STYLES = {
  notes: `---
name: notes
riff: true
description: Clear notes in your own words. Short paragraphs, lists where they help.
---
Write what the owner says as clean, readable notes in their voice.
- Remove fillers, false starts and repeated words; keep their wording otherwise.
- Short paragraphs. Use a list when they enumerate; a heading only when they change topic.
- Do not summarise, add ideas, or change the meaning.`,
  script: `---
name: script
riff: true
description: A script to read aloud, one beat per paragraph.
---
Write a script to be read aloud by the owner.
- One beat per paragraph. Short sentences that sound natural spoken; contractions are fine.
- No headings or lists unless asked. Mark a pause with a line on its own: [pause].
- Remove fillers and false starts; keep the owner's phrasing and rhythm.`,
  thread: `---
name: thread
riff: true
description: Short posts that each stand on their own.
riff-post-limit: 280
---
Write a thread of posts.
- Separate posts with a line containing only ---.
- Each post stands on its own and stays within 280 characters.
- The first post is the hook. No hashtags or emoji unless the owner says them.
- Remove fillers and false starts; keep the owner's voice.`,
} as const;

export type CoreStyle = keyof typeof CORE_STYLES;
export const DEFAULT_STYLE: CoreStyle = "notes";

export const isCoreStyle = (name: string): name is CoreStyle => Object.prototype.hasOwnProperty.call(CORE_STYLES, name);

/** A SKILL.md's name, description, post limit and body. */
export function readStyle(skill: string): { name?: string; description?: string; style: boolean; postLimit?: number; body: string } {
  const text = skill.replace(/^﻿/, "");
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!block) return { style: false, body: text.trim() };
  const field = (key: string) => block[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1].trim().replace(/^["']|["']$/g, "");
  const limit = Number(field("riff-post-limit"));
  return {
    name: field("name"),
    description: field("description"),
    style: /^(true|yes)$/i.test(field("riff") ?? ""),
    ...(Number.isInteger(limit) && limit > 0 ? { postLimit: limit } : {}),
    body: text.slice(block[0].length).trim(),
  };
}

/** What a style's name reads as in the picker: "thread" → "Thread", "hackonomics-script" → "Hackonomics script". */
export const styleLabel = (name: string) => {
  const words = name.replace(/[-_]+/g, " ").trim();
  return words ? words[0].toLocaleUpperCase() + words.slice(1) : name;
};
