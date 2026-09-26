import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, sleep } from "./browser";

// bun artifacts/dashboard/shots.ts <base> <key> <outDir> [path...]
// Screenshots of a running, seeded dashboard, light and dark, desktop and phone: for looking at, not checking.
const [base, key, outDir, ...paths] = process.argv.slice(2);
if (!base || !key || !outDir) throw new Error("usage: bun artifacts/dashboard/shots.ts <base> <key> <outDir> [path...]");
mkdirSync(outDir, { recursive: true });
const page = await launch(9335);
try {
  await page.viewport(1440, 900);
  await page.go(`${base}/chat#key=${encodeURIComponent(key)}`);
  await sleep(1200);
  for (const path of paths.length ? paths : ["/chat", "/inbox", "/work"]) {
    for (const scheme of ["light", "dark"] as const) {
      for (const [label, width, height, mobile] of [["desktop", 1440, 900, false], ["phone", 390, 844, true]] as const) {
        await page.scheme(scheme);
        await page.viewport(width, height, mobile);
        await page.go(`${base}${path}`);
        await sleep(1400);
        await page.shot(join(outDir, `${path.replace(/[/?=&]+/g, "_").replace(/^_|_$/g, "") || "root"}-${scheme}-${label}.png`));
      }
    }
  }
  console.log(page.errors.length ? page.errors : "no page errors");
} finally {
  page.close();
}
