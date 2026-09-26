import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { v } from "convex/values";
import { HOME } from "../runner/home";
import { internal } from "./_generated/api";
import { action, internalMutation, query, type ActionCtx } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";

/**
 * The desktop pet, turned on and off from the dashboard (Settings → Desktop
 * pet): `perry pet` and `perry pet off`, run by this server on the computer it
 * runs on, as they would be in a terminal there. What each is doing is kept
 * in petSetup, a step at a time, for the page to show; whether he is on
 * screen is his own check-ins (petPresence, todos.presence).
 *
 * His look is his own config file, pet.json in Perry's folder, which his
 * window keeps where he stands and watches for a theme: light, dark, or the
 * system's (the default). The dashboard's theme is each browser's own, so his
 * is set here, and he changes as soon as it is saved, running or not.
 */

/** He checks in every minute; one that has not for this long is gone. */
const PET_GONE_MS = 150_000;
/** A setup this old that never said how it ended is taken to have died with the server. */
const STALE_MS = 20 * 60_000;

export const PET_THEMES = ["system", "light", "dark"] as const;
export type PetTheme = (typeof PET_THEMES)[number];

/** His config file, shared with his window (pet/main.js), which keeps where he stands in it. */
const CONFIG = join(HOME, "pet.json");

function readConfig(): Record<string, unknown> {
  try {
    const config = JSON.parse(readFileSync(CONFIG, "utf8"));
    return config && typeof config === "object" ? config : {};
  } catch {
    return {};
  }
}

const themeOf = (config: Record<string, unknown>): PetTheme =>
  PET_THEMES.includes(config.theme as PetTheme) ? config.theme as PetTheme : "system";

export type PetView = {
  running: boolean;
  theme: PetTheme;
  /** The computer Perry runs on, where he appears. */
  host: string;
  setup: { action: "on" | "off"; state: "working" | "failed" | "done"; step?: string; error?: string; at: number } | null;
};

export const status = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<PetView> => {
    assertDashboardKey(args.key);
    const presence = await ctx.db.query("petPresence").first();
    const setup = await ctx.db.query("petSetup").first();
    const stale = setup?.state === "working" && Date.now() - setup.startedAt > STALE_MS;
    return {
      running: Boolean(presence && Date.now() - presence.seenAt < PET_GONE_MS),
      theme: themeOf(readConfig()),
      host: hostname(),
      setup: setup ? {
        action: setup.action,
        state: stale ? "failed" : setup.state,
        step: setup.step,
        error: stale ? "It stopped without saying why; try again." : setup.error,
        at: setup.finishedAt ?? setup.startedAt,
      } : null,
    };
  },
});

export const begin = internalMutation({
  args: { action: v.union(v.literal("on"), v.literal("off")) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const setup = await ctx.db.query("petSetup").first();
    // One at a time: a second click while the first is still going joins it.
    if (setup?.state === "working" && Date.now() - setup.startedAt < STALE_MS) return false;
    const row = { action: args.action, state: "working" as const, step: undefined, error: undefined, startedAt: Date.now(), finishedAt: undefined };
    if (setup) await ctx.db.patch(setup._id, row);
    else await ctx.db.insert("petSetup", row);
    return true;
  },
});

export const step = internalMutation({
  args: { text: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const setup = await ctx.db.query("petSetup").first();
    if (setup) await ctx.db.patch(setup._id, { step: args.text.slice(0, 200) });
    return null;
  },
});

export const finish = internalMutation({
  args: { error: v.optional(v.string()), gone: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const setup = await ctx.db.query("petSetup").first();
    if (setup) await ctx.db.patch(setup._id, { state: args.error ? "failed" : "done", error: args.error?.slice(0, 1000), finishedAt: Date.now() });
    // Told to quit, he is gone now, not when his last check-in grows old.
    if (args.gone && !args.error) {
      const presence = await ctx.db.query("petPresence").first();
      if (presence) await ctx.db.delete(presence._id);
    }
    return null;
  },
});

/**
 * `perry pet` (or `perry pet off`) on this computer. Its output is read as it
 * comes: a `::step` line is the step it is on; the rest is kept, and its end
 * is what the page shows if it fails.
 */
function perryPet(args: string[], onStep: (text: string) => void): Promise<{ code: number | null; output: string }> {
  // The dashboard's server runs in the checkout (perry run starts it there), and `perry run` says where Bun is.
  const repo = process.cwd();
  return new Promise((resolve) => {
    const child = spawn(process.env.PERRY_BUN || "bun", [join(repo, "scripts", "perry.ts"), "pet", ...args], {
      cwd: repo,
      env: { ...process.env, PERRY_PROGRESS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let partial = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = partial + chunk.toString("utf8");
      const lines = text.split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("::step ")) onStep(line.slice(7));
        else output += `${line}\n`;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.on("error", (error) => resolve({ code: null, output: `Could not run perry: ${error.message}` }));
    child.on("close", (code) => resolve({ code, output: output + partial }));
  });
}

/** What went wrong, as the command said it: its last lines, without the terminal's colours. */
const ending = (output: string) => output.replace(/\x1b\[[0-9;]*m/g, "").trim().split(/\r?\n/).filter((line) => line.trim()).slice(-6).join("\n");

async function run(ctx: ActionCtx, which: "on" | "off"): Promise<null> {
  if (!(await ctx.runMutation(internal.pet.begin, { action: which }))) return null;
  const result = await perryPet(which === "on" ? [] : ["off"], (text) => void ctx.runMutation(internal.pet.step, { text }).catch(() => {}));
  await ctx.runMutation(internal.pet.finish, {
    ...(result.code === 0 ? {} : { error: ending(result.output) || `perry pet${which === "off" ? " off" : ""} stopped (${result.code ?? "did not start"}).` }),
    ...(which === "off" ? { gone: true } : {}),
  });
  return null;
}

/** His theme, written to his config file; his window sees it change. */
export const setTheme = action({
  args: { key: v.string(), theme: v.union(v.literal("system"), v.literal("light"), v.literal("dark")) },
  returns: v.null(),
  handler: async (_ctx, args) => {
    assertDashboardKey(args.key);
    writeFileSync(CONFIG, `${JSON.stringify({ ...readConfig(), theme: args.theme }, null, 2)}\n`);
    return null;
  },
});

/** Turn the pet on: installed the first time, started, and started at login from now on. */
export const turnOn = action({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    return await run(ctx, "on");
  },
});

/** Turn him off, and stop him starting at login. */
export const turnOff = action({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    return await run(ctx, "off");
  },
});
