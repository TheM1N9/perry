#!/usr/bin/env bun
/**
 * `pnpm evals [--tag <tag>]... [--strict] [--runner-token <token>] [--judge-model <model>] [filter]...`
 *
 * Runs every *.eval.ts under evals/ against the live Perry, one at a time, and
 * writes artifacts/evals/<timestamp>/ with summary.json, results.jsonl and one
 * JSON file per eval. Needs a runner online with --auto: the owner's, or a
 * short-lived test runner whose token is passed with --runner-token.
 *
 * A filter matches an eval id (its path under evals/, without .eval.ts) or a
 * folder of them; a tag keeps the evals that carry it. Exit codes: 0 when
 * every gate passed (and, with --strict, every soft bar), 1 when an eval
 * failed, 2 when nothing matched or Perry could not be reached.
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { bold, dim, green, red, yellow } from "../scripts/lib";
import { Perry } from "../scripts/perry-client";
import { isEval, runEval, type EvalDefinition, type EvalResult } from "./eval";

const EVALS_DIR = import.meta.dirname;
const SUFFIX = ".eval.ts";

const { values: flags, positionals: filters } = parseArgs({
  allowPositionals: true,
  options: {
    tag: { type: "string", multiple: true },
    strict: { type: "boolean" },
    "runner-token": { type: "string" },
    "judge-model": { type: "string" },
  },
});

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/evals/runner/discover.ts
/** `evals/sub/name.eval.ts` is `sub/name`. */
function evalId(file: string): string {
  return relative(EVALS_DIR, file).split(/[\\/]/).join("/").slice(0, -SUFFIX.length);
}

/** A filter matches its exact id, or every eval in the folder it names. */
function matchesFilter(id: string, wanted: readonly string[]): boolean {
  return wanted.length === 0 || wanted.some((filter) => id === filter || id.startsWith(`${filter}/`));
}

const files = (await readdir(EVALS_DIR, { recursive: true }))
  .filter((file) => file.endsWith(SUFFIX))
  .map((file) => join(EVALS_DIR, file))
  .sort((a, b) => evalId(a).localeCompare(evalId(b)));
const evals: Array<{ id: string; definition: EvalDefinition }> = [];
for (const file of files) {
  const id = evalId(file);
  const exported = (await import(pathToFileURL(file).href)).default;
  if (!isEval(exported)) throw new Error(`${relative(process.cwd(), file)} must default-export defineEval({...}).`);
  const tags = exported.tags ?? [];
  if (matchesFilter(id, filters) && (!flags.tag?.length || tags.some((tag) => flags.tag!.includes(tag)))) {
    evals.push({ id, definition: exported });
  }
}
if (evals.length === 0) {
  console.error(red(`No evals matched${filters.length ? ` ${filters.join(", ")}` : ""}${flags.tag?.length ? ` with tag ${flags.tag.join(", ")}` : ""}.`));
  process.exit(2);
}

let perry: Perry;
try {
  perry = Perry.fromEnv(flags["runner-token"]);
} catch (error) {
  console.error(red(error instanceof Error ? error.message : String(error)));
  process.exit(2);
}

const startedAt = new Date();
console.log(`\n${bold("EVALS")} ${bold(String(evals.length))}  ${dim(flags["runner-token"] ? "on the test runner" : "on the owner's runner")}\n`);
const results: EvalResult[] = [];
for (const { id, definition } of evals) {
  const result = await runEval(id, definition, perry, { judgeModel: flags["judge-model"] });
  results.push(result);
  report(result);
}
await perry.close();

const count = (verdict: EvalResult["verdict"]) => results.filter((result) => result.verdict === verdict).length;
const summary = {
  startedAt: startedAt.toISOString(),
  completedAt: new Date().toISOString(),
  strict: Boolean(flags.strict),
  filters,
  tags: flags.tag ?? [],
  passed: count("passed"),
  failed: count("failed"),
  scored: count("scored"),
  total: results.length,
  evals: results.map(({ id, verdict, error, assertions, cleanupErrors, durationMs }) => ({ id, verdict, error, durationMs, assertions, cleanupErrors })),
};
const outDir = await writeArtifacts(summary, results);

const parts = [
  summary.passed && green(`${summary.passed} passed`),
  summary.failed && red(`${summary.failed} failed`),
  summary.scored && yellow(`${summary.scored} scored`),
].filter(Boolean);
console.log(`\n${bold("Results:")} ${parts.join(", ")} ${dim(`(${summary.total} total, ${seconds(Date.now() - startedAt.getTime())})`)}`);
console.log(dim(`Artifacts in ${relative(process.cwd(), outDir)}\n`));
process.exit(summary.failed > 0 || (flags.strict && summary.scored > 0) ? 1 : 0);

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/evals/runner/reporters/console.ts
function report(result: EvalResult) {
  const icon = { passed: green("✓"), failed: red("✗"), scored: yellow("○") }[result.verdict];
  const gates = result.assertions.filter((assertion) => assertion.severity === "gate");
  const passedGates = gates.filter((gate) => gate.passed).length;
  const gateText = gates.length ? (passedGates === gates.length ? green : red)(`gates ${passedGates}/${gates.length}`) : "";
  const scores = result.assertions.filter((assertion) => assertion.severity === "soft")
    .map((assertion) => (assertion.score === 1 ? green : assertion.score === 0 ? red : yellow)(`${assertion.name}: ${Math.round(assertion.score * 100)}%`));
  console.log([icon, result.id, gateText, ...scores, dim(seconds(result.durationMs))].filter(Boolean).join("  "));
  for (const assertion of result.assertions) {
    if (assertion.passed) continue;
    const bar = assertion.threshold ?? (assertion.severity === "gate" ? 1 : undefined);
    const comparison = bar === undefined ? "" : ` (${Math.round(assertion.score * 100)}% < ${Math.round(bar * 100)}%)`;
    console.log(red(`  ✗ ${assertion.name}${comparison}${assertion.message ? `: ${assertion.message.split("\n")[0]!.slice(0, 300)}` : ""}`));
  }
  if (result.error) console.log(red(`  ${result.error}`));
  for (const problem of result.cleanupErrors) console.log(yellow(`  cleanup: ${problem}`));
}

function seconds(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/evals/runner/artifacts.ts
/** artifacts/evals/<timestamp>/: summary.json, results.jsonl, and evals/<id>.json with every turn. */
async function writeArtifacts(summaryArtifact: typeof summary, all: EvalResult[]): Promise<string> {
  const dir = join(EVALS_DIR, "..", "artifacts", "evals", startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19));
  await mkdir(join(dir, "evals"), { recursive: true });
  await writeFile(join(dir, "summary.json"), JSON.stringify(summaryArtifact, null, 2) + "\n");
  await writeFile(join(dir, "results.jsonl"), all.map(({ id, verdict, error, assertions, turns }) =>
    JSON.stringify({ id, verdict, error, output: turns.at(-1)?.message, assertions })).join("\n") + "\n");
  for (const result of all) {
    // Ids keep their folders; anything else unsafe in a path becomes "_".
    const path = join(dir, "evals", `${result.id.split("/").map((segment) => segment.replace(/[^a-zA-Z0-9_-]/g, "_")).join("/")}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(result, null, 2) + "\n");
  }
  return dir;
}
