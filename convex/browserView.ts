import { v } from "convex/values";
import { query } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";

/** Visibility and import are independent server flags; no credential operations are model tools. */
export const settings = query({
  args: { key: v.string() },
  handler: (_ctx, { key }) => {
    assertDashboardKey(key);
    return { enabled: process.env.PERRY_BROWSER_VIEW === "1" };
  },
});
