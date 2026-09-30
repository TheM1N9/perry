import { v } from "convex/values";
import { action } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import { listSkills, readSkill, removeSkill, type InstalledSkill } from "./lib/skills";

/**
 * The Skills page, and the $ list in the chat composer: the skills in
 * Perry's skills folder, the one every engine is pointed at. They live on
 * disk rather than in the database (Perry writes them there in a chat, and
 * install_skill moves them there), so these read the folder each time, as
 * actions: a live query would not see a skill written on disk.
 */

export type SkillView = InstalledSkill;

export const list = action({
  args: { key: v.string() },
  handler: async (_ctx, args): Promise<SkillView[]> => {
    assertDashboardKey(args.key);
    return listSkills();
  },
});

/** One skill's SKILL.md, and the other files in its folder. */
export const read = action({
  args: { key: v.string(), folder: v.string() },
  handler: async (_ctx, args): Promise<ReturnType<typeof readSkill>> => {
    assertDashboardKey(args.key);
    return readSkill(args.folder);
  },
});

/** Delete a skill's folder. A chat that names it afterwards gets its name as plain text. */
export const remove = action({
  args: { key: v.string(), folder: v.string() },
  handler: async (_ctx, args): Promise<{ name: string }> => {
    assertDashboardKey(args.key);
    return removeSkill(args.folder);
  },
});
