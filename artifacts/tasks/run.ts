import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { openChat, sleep } from "../browser";

// bun artifacts/tasks/run.ts <outDir> <dashboardKey>
// Needs `next dev -p 3005` and CONVEX_URL for a deployment with this branch's
// dashboard functions and its built-in jobs. Read-only: the built-in group is
// opened and closed, and no job is run, paused or deleted.
//
// Ways this could fail, and what catches each:
//   1. The rename is partial: the sidebar item, the heading, the breadcrumb and
//      the tab title must all say Tasks, and nothing on the page may say Work.
//   2. Old links break: /work must answer with a redirect to /tasks, and a
//      browser opening /work must land on the Tasks page.
//   3. Built-ins still lead: none of the built-in jobs' names may appear as a
//      top-level row of Scheduled; they must sit in a "Built in" group that
//      starts closed and counts every built-in job the server has.
//   4. Folding them away hides trouble: the group's closed line must say how
//      many enabled built-ins failed their last run, matching the server.
//   5. Built-ins become unreachable: opened, the group must show each one
//      with Run now and Pause or Resume, and no Delete.
//   6. Your own jobs get tucked away with them: every job that is not built
//      in must be a top-level row, or the empty state must show if there are none.
//   7. The phone layout breaks: at 390px the group's line fits the card and
//      the document does not scroll.

const [outDir, dashboardKey] = process.argv.slice(2);
if (!outDir || !dashboardKey) throw new Error("usage: bun artifacts/tasks/run.ts <outDir> <dashboardKey>");
mkdirSync(outDir, { recursive: true });

const base = "http://localhost:3005";
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};

const { jobs } = await convex.query(api.jobs.listForDashboard, { key: dashboardKey });
const builtins = jobs.filter((job) => job.builtin);
const yours = jobs.filter((job) => !job.builtin);
const failing = builtins.filter((job) => job.enabled && job.lastError).length;
notes.server = { builtins: builtins.map((job) => job.name), yours: yours.map((job) => job.name), failingBuiltins: failing };

// 2. The redirect, as the server answers it.
const redirect = await fetch(`${base}/work`, { redirect: "manual" });
notes.workRedirect = { status: redirect.status, location: redirect.headers.get("location") };
checks.workRedirectsToTasks = redirect.status >= 300 && redirect.status < 400 && new URL(redirect.headers.get("location") ?? "", base).pathname === "/tasks";

const browser = await openChat(base, dashboardKey);
const { evaluate, send } = browser;
const waitFor = (test: string, what: string) => evaluate(`new Promise((resolve, reject) => { const start = Date.now(); const tick = () => (${test}) ? resolve(true) : Date.now() - start > 30000 ? reject(new Error(${JSON.stringify(what)})) : setTimeout(tick, 150); tick(); })`);
const shot = async (name: string) => writeFileSync(join(outDir, name), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
const scheduled = `[...document.querySelectorAll(".section")].find((s) => s.querySelector("h2")?.innerText.startsWith("Scheduled"))`;
const openTasks = async (path: string) => {
  await send("Page.navigate", { url: `${base}${path}` });
  await waitFor(`!!(${scheduled}) && !(${scheduled}).querySelector(".loading")`, `Scheduled never loaded from ${path}`);
  await sleep(400);
};

try {
  // 2. A browser on /work.
  await openTasks("/work");
  checks.workLandsOnTasks = await evaluate(`location.pathname === "/tasks"`);

  // 1. The name everywhere.
  const names = await evaluate(`({
    nav: [...document.querySelectorAll("nav[aria-label=Main] a")].map((a) => a.innerText.trim()),
    heading: document.querySelector(".page-head h1").innerText,
    crumb: document.querySelector(".breadcrumb").innerText.replace(/\\s+/g, " ").trim(),
    title: document.title,
    saysWork: /\\bWork\\b/.test(document.querySelector("main").innerText) || /\\bWork\\b/.test(document.querySelector(".sidebar-actions").innerText),
  })`);
  notes.names = names;
  checks.renamedEverywhere = JSON.stringify(names.nav) === JSON.stringify(["Tasks"]) && names.heading === "Tasks"
    && names.crumb === "Perry / Tasks" && names.title === "Tasks · Perry" && !names.saysWork;

  // 3 and 6. What leads the Scheduled section.
  const layout = await evaluate(`(() => {
    const section = ${scheduled};
    const topRows = [...section.querySelectorAll(".section-body > .item .item-title")].map((el) => el.innerText.trim());
    const group = section.querySelector("details.builtin-jobs");
    return {
      topRows,
      empty: !!section.querySelector(".section-body > .empty"),
      groupOpen: group?.open ?? null,
      groupCount: Number(group?.querySelector("summary .section-count")?.innerText ?? -1),
      summary: group?.querySelector("summary").innerText.replace(/\\s+/g, " ").trim() ?? null,
      summaryFits: group ? group.querySelector("summary").scrollWidth <= group.querySelector("summary").clientWidth + 1 : false,
    };
  })()`);
  notes.layout = layout;
  checks.builtinsNotTopLevel = builtins.every((job) => !layout.topRows.includes(job.name));
  checks.groupStartsClosedWithCount = layout.groupOpen === false && layout.groupCount === builtins.length;
  checks.yourJobsLead = yours.length === 0 ? layout.empty : yours.every((job) => layout.topRows.includes(job.name));

  // 4. Failures still show while folded.
  const failedMatch = /(\d+) failed/.exec(layout.summary ?? "");
  checks.foldedLineShowsFailures = failing === 0 ? !failedMatch : Number(failedMatch?.[1]) === failing;
  await shot("tasks-folded.png");

  // 5. Opened, every built-in is there with its controls.
  await evaluate(`(${scheduled}).querySelector("details.builtin-jobs > summary").click(); true`);
  await waitFor(`(${scheduled}).querySelector("details.builtin-jobs").open`, "the Built in group did not open");
  const inside = await evaluate(`[...(${scheduled}).querySelectorAll("details.builtin-jobs .item")].map((item) => ({
    name: item.querySelector(".item-title").innerText.trim(),
    buttons: [...item.querySelectorAll("button")].map((b) => b.innerText.trim()),
  }))`);
  notes.inside = inside;
  checks.builtinsReachable = builtins.every((job) => {
    const row = inside.find((item: { name: string }) => item.name === job.name);
    return row && row.buttons.includes("Run now") && (row.buttons.includes("Pause") || row.buttons.includes("Resume")) && !row.buttons.includes("Delete");
  });
  await shot("tasks-open.png");
  await evaluate(`(${scheduled}).querySelector("details.builtin-jobs > summary").click(); true`);

  // 7. Phone.
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await openTasks("/tasks");
  checks.phoneFits = await evaluate(`(() => { const s = (${scheduled}).querySelector("details.builtin-jobs > summary"); return s.scrollWidth <= s.clientWidth + 1 && document.documentElement.scrollHeight <= innerHeight; })()`);
  await shot("tasks-phone.png");

  notes.pageErrors = browser.errors;
  checks.noPageErrors = browser.errors.length === 0;
} finally {
  browser.close();
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exit(1);
