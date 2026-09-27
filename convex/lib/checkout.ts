import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Where Perry's git checkout stands against the branch it follows, for Perry
 * keeping himself up to date. The server asks, to offer an update
 * (convex/updates.ts); `perry run`, which does the update, asks again before
 * it stops anything (scripts/perry.ts). Only a fast-forward is ever offered:
 * a checkout with changes or commits of its own is the owner's to update.
 */

export type Standing = {
  /** The commit the checkout is on. */
  head?: string;
  /** How many commits the branch it follows has that it does not. */
  behind: number;
  /** The newest of them. */
  latest?: { sha: string; title: string };
  /** Why no update can be offered from here, said for the owner. */
  problem?: string;
};

/** An update the dashboard asks `perry run` for, in update-request.json. */
export type UpdateRequest = { id: string; at: number; by: "owner" | "nightly" };

/** How it went, in update-result.json, for the dashboard to show. */
export type UpdateResult = {
  id: string;
  by: "owner" | "nightly";
  at: number;
  ok: boolean;
  /** The commit Perry was on, and the one he went to (or tried to). */
  from?: string;
  to?: string;
  title?: string;
  error?: string;
  /** The end of what the update said, for when it failed. */
  log?: string;
};

/** A git command in the checkout. It never asks for a password: nobody is there to answer. */
export function git(repo: string, args: string[], timeoutMs = 30_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile("git", args, {
      cwd: repo,
      timeout: timeoutMs,
      windowsHide: true,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    }, (error, stdout, stderr) => {
      const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
      resolve({ ok: !error, output: output || (error?.killed ? "it took too long" : error?.message ?? "") });
    });
  });
}

const firstLine = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";

/** Where the checkout at `repo` stands; with fetch, after asking its remote for what is new. Never throws. */
export async function standing(repo: string, { fetch = true } = {}): Promise<Standing> {
  if (!existsSync(join(repo, ".git"))) return { behind: 0, problem: "This copy of Perry isn't a git checkout, so it can't update itself." };
  const head = await git(repo, ["rev-parse", "HEAD"]);
  if (!head.ok) return { behind: 0, problem: `git isn't working here: ${firstLine(head.output)}` };
  const here = { head: head.output };
  if (!(await git(repo, ["rev-parse", "--abbrev-ref", "@{upstream}"])).ok) {
    return { ...here, behind: 0, problem: "This copy of Perry isn't following a branch, so there's nothing to update from." };
  }
  if (fetch) {
    const fetched = await git(repo, ["fetch", "--quiet"], 90_000);
    if (!fetched.ok) return { ...here, behind: 0, problem: `Couldn't check for updates: ${firstLine(fetched.output)}` };
  }
  const counts = await git(repo, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
  const [ahead, behind] = counts.output.split(/\s+/).map(Number);
  if (!counts.ok || !Number.isInteger(ahead) || !Number.isInteger(behind)) return { ...here, behind: 0, problem: `Couldn't compare with the latest: ${firstLine(counts.output)}` };
  if (!behind) return { ...here, behind: 0 };
  const newest = await git(repo, ["log", "-1", "--no-decorate", "--format=%H %s", "@{upstream}"]);
  const [sha, ...title] = newest.output.split(" ");
  const found = { ...here, behind, latest: { sha, title: title.join(" ") } };
  // Moving to the latest would mean merging, or touching what the owner changed: that is theirs to do.
  if (ahead) return { ...found, problem: "This copy of Perry has commits of its own, so he won't update it himself. Pull the latest with git." };
  const changed = await git(repo, ["status", "--porcelain", "--untracked-files=no"]);
  if (!changed.ok || changed.output) return { ...found, problem: "This copy of Perry has changes that aren't committed, so he won't update it himself. Commit or stash them first." };
  return found;
}
