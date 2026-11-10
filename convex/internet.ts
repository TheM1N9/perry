import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { keptSecrets } from "./vault";
import { scrub } from "./lib/secrets";

/** The final evidence boundary hides saved secrets before any tool result reaches a model or trace. */
export const clean = internalQuery({
  args: { json: v.string() },
  handler: async (ctx, args): Promise<string> => {
    const secrets = await keptSecrets(ctx);
    const cleanValue = (value: unknown): unknown => {
      if (typeof value === "string") return scrub(value, secrets).text;
      if (Array.isArray(value)) return value.map(cleanValue);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanValue(item)]));
      return value;
    };
    return JSON.stringify(cleanValue(JSON.parse(args.json)));
  },
});
