import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { v } from "convex/values";
import { HOME } from "../runner/home";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, mutation, query, type ActionCtx, type QueryCtx } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import { hashOf, PET_KEY_PREFIX, reachableAddresses } from "./lib/devices";
import { presenceOf } from "./todos";

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
 *
 * He can be on the owner's other computers too. Settings makes a pairing
 * code; the pet installed there (pet/connect.js) trades it for a key of its
 * own, which opens only what his page does (server/devices.ts), and is
 * listed there with when it was last heard from, to remove, which takes the
 * key away.
 */

/** He checks in every minute; one that has not for this long is gone. */
const PET_GONE_MS = 150_000;
/** A setup this old that never said how it ended is taken to have died with the server. */
const STALE_MS = 20 * 60_000;
/** A page he asked to open that nobody took in this long is let go, so a tab opened later does not jump to it. */
const OPEN_FRESH_MS = 5_000;

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

/** The check-ins of the pet on Perry's own computer, the one turned on and off here; the others have a device. */
const homePet = async (ctx: QueryCtx) => (await ctx.db.query("petPresence").collect()).find((row) => !row.device) ?? null;

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
    const presence = await homePet(ctx);
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
      const presence = await homePet(ctx);
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

/**
 * A page of the dashboard, opened from the pet in a tab already open when
 * there is one. The pet asks here; every unlocked dashboard tab watches the
 * latest ask (components/dashboard/shell.tsx), and the first to claim it goes
 * there. The pet claims it too, a moment later: if it wins, no dashboard was
 * open, and it opens a new tab as before.
 */
export const askToOpen = mutation({
  args: { key: v.string(), path: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    // A page of this app, never a link elsewhere (`//host`, `/\host`) or a script.
    const path = /^\/(?![/\\])/.test(args.path) ? args.path.slice(0, 2000) : "/";
    const row = { request: crypto.randomUUID(), path, at: Date.now(), claimedAt: undefined };
    const existing = await ctx.db.query("petOpen").first();
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("petOpen", row);
    return row.request;
  },
});

/** The latest ask, for the dashboard's tabs to watch. */
export const openRequest = query({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const row = await ctx.db.query("petOpen").first();
    return row ? { request: row.request, path: row.path, claimed: row.claimedAt !== undefined } : null;
  },
});

/** Take the ask: true for the first to claim it while it is fresh, false for everyone after. */
export const claimOpen = mutation({
  args: { key: v.string(), request: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const row = await ctx.db.query("petOpen").first();
    if (!row || row.request !== args.request || row.claimedAt !== undefined || Date.now() - row.at > OPEN_FRESH_MS) return false;
    await ctx.db.patch(row._id, { claimedAt: Date.now() });
    return true;
  },
});

// --- On the owner's other computers ------------------------------------------

/** How long a pairing code works once made: time to walk over to the other computer and paste it. */
const PAIRING_MS = 10 * 60_000;
/** Wrong codes tried while one is open, before it is closed: guessing one of 30^8 codes this many times goes nowhere. */
const PAIRING_MISSES = 10;
/** A code's letters: no 0 and O, 1, I and L, or U, so it reads out and types without doubt. */
const CODE_LETTERS = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CODE_LENGTH = 8;

function newCode(): string {
  let code = "";
  while (code.length < CODE_LENGTH) {
    // 240 is the largest multiple of 30 under 256, so every letter is as likely as the next.
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) if (byte < 240 && code.length < CODE_LENGTH) code += CODE_LETTERS[byte % 30];
  }
  return code;
}

/** As typed: any case, with or without its dash or spaces. */
const plainCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

function newKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return PET_KEY_PREFIX + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type PetDeviceView = {
  /** None for the pet on Perry's own computer. */
  id: Id<"petDevices"> | null;
  name: string;
  platform?: string;
  pairedAt?: number;
  /** When it last checked in, and whether that is recent enough for it to be running. */
  seenAt?: number;
  running: boolean;
  /** Of those running, the one the owner touched last: where the screen is looked at. */
  current: boolean;
};

export type PetDevicesView = {
  /** Perry's own computer first, then each other computer paired, newest first. */
  devices: PetDeviceView[];
  /** A pairing code still open: when it stops working. The code itself is shown once, as it is made. */
  pairing: { expiresAt: number } | null;
  /** Where another computer may reach this server: Tailscale first, then the local network. */
  addresses: Array<{ address: string; tailscale: boolean }>;
  port: number;
  /** PERRY_HOST keeps the server to this computer: no other one can reach it. */
  loopbackOnly: boolean;
  /** Whether the owner is at any of them (todos.presenceOf): away only when every pet running has seen them gone. */
  presence: "here" | "away" | "unknown";
};

/** The pets on each computer, for Settings → Desktop pet. */
export const devices = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<PetDevicesView> => {
    assertDashboardKey(args.key);
    const now = Date.now();
    const presence = await ctx.db.query("petPresence").collect();
    const [current] = presence.filter((row) => now - row.seenAt < PET_GONE_MS).sort((a, b) => b.activeAt - a.activeAt || b.seenAt - a.seenAt);
    const seen = (id: Id<"petDevices"> | null) => {
      const row = presence.find((pet) => (pet.device ?? null) === id);
      return { seenAt: row?.seenAt, running: Boolean(row && now - row.seenAt < PET_GONE_MS), current: Boolean(current && (current.device ?? null) === id) };
    };
    const paired = await ctx.db.query("petDevices").order("desc").collect();
    const pairing = await ctx.db.query("petPairing").first();
    const loopbackOnly = /^(127\.0\.0\.1|localhost|::1)$/.test(process.env.PERRY_HOST ?? "");
    return {
      devices: [
        { id: null, name: hostname(), ...seen(null) },
        ...paired.map((device) => ({ id: device._id, name: device.name, platform: device.platform, pairedAt: device.pairedAt, ...seen(device._id) })),
      ],
      pairing: pairing && pairing.expiresAt > now && pairing.misses < PAIRING_MISSES ? { expiresAt: pairing.expiresAt } : null,
      addresses: loopbackOnly ? [] : reachableAddresses(),
      port: Number(process.env.PERRY_PORT ?? process.env.PORT ?? 7377),
      loopbackOnly,
      presence: await presenceOf(ctx, now),
    };
  },
});

/** A new pairing code, in place of any still open; shown once, as XXXX-XXXX. */
export const pair = mutation({
  args: { key: v.string() },
  returns: v.object({ code: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const code = newCode();
    const row = { codeHash: await hashOf(code), expiresAt: Date.now() + PAIRING_MS, misses: 0 };
    const existing = await ctx.db.query("petPairing").first();
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("petPairing", row);
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: row.expiresAt };
  },
});

/** The code shown, taken back before anyone uses it. */
export const cancelPairing = mutation({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const existing = await ctx.db.query("petPairing").first();
    if (existing) await ctx.db.delete(existing._id);
    return null;
  },
});

/**
 * A pet on another computer pairing (pet/connect.js), with the code from
 * Settings and nothing else: no dashboard key. The code works once, for a few
 * minutes, and is traded for a key of the pet's own, given here once and kept
 * only as a hash. A wrong code counts against the open one, which closes after
 * a few. What went wrong is returned rather than thrown, so that the count is kept.
 */
export const redeem = mutation({
  args: { code: v.string(), name: v.string(), platform: v.optional(v.string()) },
  returns: v.union(v.object({ key: v.string(), device: v.id("petDevices"), name: v.string() }), v.object({ error: v.string() })),
  handler: async (ctx, args) => {
    const pairing = await ctx.db.query("petPairing").first();
    const open = pairing && pairing.expiresAt > Date.now() && pairing.misses < PAIRING_MISSES ? pairing : null;
    if (!open || open.codeHash !== await hashOf(plainCode(args.code))) {
      if (open) await ctx.db.patch(open._id, { misses: open.misses + 1 });
      return { error: "That pairing code is wrong, already used, or expired. Make a new one in Perry's Settings → Desktop pet." };
    }
    await ctx.db.delete(open._id);
    const key = newKey();
    const name = args.name.trim().slice(0, 80) || "Another computer";
    const device = await ctx.db.insert("petDevices", { name, platform: args.platform?.slice(0, 40), keyHash: await hashOf(key), pairedAt: Date.now() });
    return { key, device, name };
  },
});

/** A computer removed: its key stops working at once, its pet is no longer counted, and Perry stops waiting on it for a look. */
export const removeDevice = mutation({
  args: { key: v.string(), id: v.id("petDevices") },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    if (!(await ctx.db.get(args.id))) return null;
    await ctx.db.delete(args.id);
    for (const row of await ctx.db.query("petPresence").collect()) if (row.device === args.id) await ctx.db.delete(row._id);
    for (const row of await ctx.db.query("screenLooks").withIndex("by_status", (q) => q.eq("status", "asked")).collect()) {
      if (row.device === args.id) await ctx.db.patch(row._id, { status: "failed", error: "That computer was removed from Perry." });
    }
    return null;
  },
});
