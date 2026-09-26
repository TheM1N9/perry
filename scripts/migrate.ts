#!/usr/bin/env bun
/**
 * `perry migrate`: bring an install's chats, memory, USER.md, tasks, jobs and
 * files over from Convex, where Perry used to keep them, to this computer.
 *
 *   perry migrate                  export from the Convex deployment in .env.local, then import
 *   perry migrate --from <zip>     import an export you already have (npx convex export)
 *   perry migrate --replace        import even though this Perry already has chats
 *
 * Perry must be running (perry start), since its server owns the database.
 * The Convex deployment is only read, never changed; delete it yourself at
 * dashboard.convex.dev once you are happy.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HOME, ensureHome } from "../runner/home";
import { bold, dim, green, red, runConvex, yellow } from "./lib";

const ENV_FILE = resolve(process.cwd(), ".env.local");
const PORT = Number(process.env.PERRY_PORT ?? 3000);
const CONVEX_KEYS = ["CONVEX_DEPLOYMENT", "CONVEX_URL", "NEXT_PUBLIC_CONVEX_URL", "CONVEX_SITE_URL", "TELEGRAM_WEBHOOK_SECRET"];

const say = (text = "") => console.log(text);
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };

function envLines(): string[] {
  return existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split(/\r?\n/) : [];
}
const envValue = (key: string) => envLines().find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1).trim();

async function main() {
  say(`\n${bold("Bringing Perry over from Convex")}`);
  const key = envValue("DASHBOARD_KEY");
  if (!key) { say(red("  No dashboard key in .env.local. Run perry setup first.\n")); process.exit(1); }

  const up = await fetch(`http://127.0.0.1:${PORT}/api/backend/http/health`).then((r) => r.ok, () => false);
  if (!up) { say(red(`  Perry is not running here. Start it with ${bold("perry start")}, then run this again.\n`)); process.exit(1); }

  let zip = option("--from");
  if (!zip) {
    const deployment = envValue("CONVEX_DEPLOYMENT")?.replace(/\s+#.*$/, "");
    if (!deployment) {
      say(dim("  Nothing to bring over: this Perry has no Convex deployment in .env.local."));
      say(dim(`  To import an export you have: ${bold("perry migrate --from <file.zip>")}\n`));
      return;
    }
    ensureHome();
    zip = join(HOME, `convex-export-${new Date().toISOString().slice(0, 10)}.zip`);
    say(dim(`  Exporting ${deployment} (chats, memory and files) to ${zip}…`));
    const exported = await runConvex(["export", "--include-file-storage", "--path", zip]);
    if (exported.code !== 0 || !existsSync(zip)) {
      say(red("  The export failed:"));
      say(dim(exported.output.split(/\r?\n/).filter((line) => line.trim()).slice(-6).join("\n")));
      say(dim(`  If it asks you to log in: ${bold("npx convex login")}, then run this again.\n`));
      process.exit(1);
    }
    say(`  ${green("exported")} ${zip}`);

    // Keys set with `convex env set` are not in an export; ones Perry uses come over as saved keys.
    for (const name of ["COMPOSIO_API_KEY", "TELEGRAM_BOT_TOKEN"]) {
      if (envValue(name)) continue;
      const got = await runConvex(["env", "get", name]);
      const value = got.code === 0 ? got.output.trim().split(/\r?\n/).at(-1)?.trim() : "";
      if (!value || /not found|no such/i.test(value)) continue;
      const saved = await fetch(`http://127.0.0.1:${PORT}/api/backend/admin`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-perry-key": key },
        body: JSON.stringify({ path: "secrets:set", args: { name, value } }),
      }).then((r) => r.ok, () => false);
      if (saved) say(`  ${green("kept")} ${name}${dim(" from the deployment's settings")}`);
    }
  }

  const response = await fetch(`http://127.0.0.1:${PORT}/api/backend/import`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-perry-key": key },
    body: JSON.stringify({ path: resolve(zip), replace: flag("--replace") }),
  });
  const body = await response.json().catch(() => ({})) as { value?: { tables: Record<string, number>; messages: number; threads: number; files: number }; error?: string };
  if (!response.ok || !body.value) {
    say(red(`  The import failed: ${body.error ?? response.status}\n`));
    process.exit(1);
  }
  const { tables, messages, threads, files } = body.value;
  say(`  ${green("imported")} ${tables.conversations ?? 0} chats (${threads} histories, ${messages} messages), ${tables.memories ?? 0} memories, ${files} files`);
  say(dim(`  also ${Object.entries(tables).filter(([table]) => !["conversations", "memories"].includes(table)).map(([table, count]) => `${count} ${table}`).join(", ")}`));

  // Done with Convex: its settings leave .env.local, kept aside in case they are wanted again.
  const lines = envLines();
  const convex = lines.filter((line) => CONVEX_KEYS.some((name) => line.startsWith(`${name}=`)));
  if (convex.length) {
    writeFileSync(`${ENV_FILE}.convex`, convex.join("\n") + "\n");
    writeFileSync(ENV_FILE, lines.filter((line) => !convex.includes(line)).join("\n"));
    say(dim(`  Convex's settings moved from .env.local to .env.local.convex.`));
  }
  say(yellow(`\n  Your Convex deployment is untouched. Delete it at dashboard.convex.dev when you no longer need it.\n`));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
