import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import {
  applyOverride,
  MODE_NAMES,
  sanitizeTools,
  type Mode,
  type ModeName,
} from "./modes";
import { vMode } from "./schema";

/**
 * Reads and writes the per-mode overrides. The merge lives in modes.ts; this
 * file is only the storage around it.
 */

export const resolveMode = internalQuery({
  args: { mode: vMode },
  handler: async (ctx, args): Promise<Mode> => {
    const override = await ctx.db
      .query("modeConfigs")
      .withIndex("by_mode", (q) => q.eq("mode", args.mode))
      .unique();

    return applyOverride(args.mode, override ?? undefined);
  },
});

export const resolveAllModes = internalQuery({
  args: {},
  handler: async (ctx): Promise<Mode[]> => {
    const overrides = await ctx.db.query("modeConfigs").collect();
    const byMode = new Map(overrides.map((o) => [o.mode, o]));
    return MODE_NAMES.map((name) => applyOverride(name, byMode.get(name)));
  },
});

/**
 * Upsert an override. Passing null for a field clears it, which restores the
 * shipped default rather than blanking the value.
 */
export const updateMode = internalMutation({
  args: {
    mode: vMode,
    model: v.optional(v.union(v.string(), v.null())),
    stepBudget: v.optional(v.union(v.number(), v.null())),
    tools: v.optional(v.union(v.array(v.string()), v.null())),
    instructions: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("modeConfigs")
      .withIndex("by_mode", (q) => q.eq("mode", args.mode))
      .unique();

    // `undefined` means "leave as is", `null` means "clear back to default".
    const resolve = <T>(next: T | null | undefined, current: T | undefined) => {
      if (next === undefined) return current;
      if (next === null) return undefined;
      return next;
    };

    const tools =
      args.tools === undefined
        ? existing?.tools
        : args.tools === null
          ? undefined
          : sanitizeTools(args.tools);

    const patch = {
      mode: args.mode,
      model: resolve(args.model, existing?.model),
      stepBudget: resolve(args.stepBudget, existing?.stepBudget),
      tools,
      instructions: resolve(args.instructions, existing?.instructions),
      updatedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.replace(existing._id, patch);
    } else {
      await ctx.db.insert("modeConfigs", patch);
    }
    return null;
  },
});

export const resetMode = internalMutation({
  args: { mode: vMode },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("modeConfigs")
      .withIndex("by_mode", (q) => q.eq("mode", args.mode))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    return null;
  },
});

/** Which fields are currently overridden, for the dashboard to show. */
export const overriddenFields = internalQuery({
  args: {},
  handler: async (ctx): Promise<Record<string, string[]>> => {
    const overrides = await ctx.db.query("modeConfigs").collect();
    const result: Record<string, string[]> = {};
    for (const o of overrides) {
      const fields: string[] = [];
      if (o.model !== undefined) fields.push("model");
      if (o.stepBudget !== undefined) fields.push("stepBudget");
      if (o.tools !== undefined) fields.push("tools");
      if (o.instructions !== undefined) fields.push("instructions");
      if (fields.length > 0) result[o.mode as ModeName] = fields;
    }
    return result;
  },
});
