"use node";

import { Daytona, type Sandbox } from "@daytona/sdk";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, type ActionCtx } from "./_generated/server";

/**
 * Agent P's computer: one Linux sandbox, created on first use, reused after.
 *
 * The shape is lifted from OpenMuse's container model, because the reasoning
 * behind it is right:
 *
 *   No credentials inside.   Nothing in here can leak a token, because no token
 *                            is ever put here. Composio holds OAuth and stays
 *                            on the Convex side.
 *   Bounded commands.        30 seconds, output capped. A command that hangs
 *                            fails loudly instead of holding a turn open.
 *   Receipts, not retries.   Every command carries an operationId. Asking twice
 *                            with the same id returns the first receipt rather
 *                            than running it again, so an interrupted command
 *                            is never silently repeated.
 *   Persistent workspace.    /workspace survives stop and restart.
 *
 * One deliberate difference: OpenMuse disables networking in the container and
 * browses in a separate worker. Perry leaves the network on, because without it
 * the sandbox cannot install a package or clone a repo, which is most of what
 * it is for. That is a real widening of the blast radius and the reason this
 * whole file is bound to Agent P only.
 */

const WORKSPACE = "/home/daytona/workspace";
const COMMAND_TIMEOUT_SECONDS = 30;
const MAX_OUTPUT = 20_000;
const MAX_FILE_BYTES = 256 * 1024;

function requireKey(): void {
  if (!process.env.DAYTONA_API_KEY) {
    throw new Error(
      "DAYTONA_API_KEY is not set, so Perry has no computer. Get a key at " +
        "daytona.io, then: npx convex env set DAYTONA_API_KEY <key>",
    );
  }
}

function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT) return { text, truncated: false };
  return { text: text.slice(0, MAX_OUTPUT), truncated: true };
}

/** Reuse the recorded sandbox, restart it if stopped, otherwise make one. */
async function open(ctx: ActionCtx): Promise<Sandbox> {
  requireKey();
  const daytona = new Daytona();

  const existingId: string | null = await ctx.runQuery(
    internal.installation.getSandboxId,
    {},
  );

  if (existingId) {
    try {
      const sandbox = await daytona.get(existingId);
      if (String(sandbox.state) !== "started") {
        await daytona.start(sandbox);
      }
      return sandbox;
    } catch {
      // Deleted out from under us, or archived past recovery. Fall through and
      // build a fresh one rather than failing the turn.
    }
  }

  const sandbox = await daytona.create({
    language: "typescript",
    labels: { app: "perry" },
    // Stops itself after 15 idle minutes, so an install that is used once a
    // week costs roughly nothing.
    autoStopInterval: 15,
    autoArchiveInterval: 60 * 24 * 7,
  });

  await sandbox.process.executeCommand(`mkdir -p ${WORKSPACE}`);
  await ctx.runMutation(internal.installation.setSandboxId, {
    sandboxId: sandbox.id,
  });
  return sandbox;
}

export const status = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    configured: boolean;
    sandboxId?: string;
    state?: string;
    workspace: string;
    note?: string;
  }> => {
    if (!process.env.DAYTONA_API_KEY) {
      return {
        configured: false,
        workspace: WORKSPACE,
        note: "No DAYTONA_API_KEY on this deployment, so there is no computer yet.",
      };
    }

    const existingId: string | null = await ctx.runQuery(
      internal.installation.getSandboxId,
      {},
    );
    if (!existingId) {
      return {
        configured: true,
        workspace: WORKSPACE,
        note: "No sandbox yet. It is created the first time you run something.",
      };
    }

    try {
      const daytona = new Daytona();
      const sandbox = await daytona.get(existingId);
      return {
        configured: true,
        sandboxId: sandbox.id,
        state: String(sandbox.state),
        workspace: WORKSPACE,
      };
    } catch (error) {
      return {
        configured: true,
        sandboxId: existingId,
        workspace: WORKSPACE,
        note: `Recorded sandbox is unreachable: ${
          error instanceof Error ? error.message : String(error)
        }. The next command makes a new one.`,
      };
    }
  },
});

export const exec = internalAction({
  args: {
    command: v.string(),
    operationId: v.string(),
    cwd: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    exitCode: number | null;
    output: string;
    truncated: boolean;
    replayed?: boolean;
    error?: string;
  }> => {
    // A repeated operationId returns the original receipt. The model retries
    // more eagerly than it should, and a re-run `rm` or `git push` is not a
    // retry, it is a second event.
    const prior = await ctx.runQuery(internal.work.findReceipt, {
      operationId: args.operationId,
    });
    if (prior) {
      return {
        exitCode: prior.exitCode ?? null,
        output: prior.output ?? "",
        truncated: prior.truncated ?? false,
        replayed: true,
        ...(prior.error ? { error: prior.error } : {}),
      };
    }

    const receiptId = await ctx.runMutation(internal.work.startReceipt, {
      operationId: args.operationId,
      command: args.command,
    });

    try {
      const sandbox = await open(ctx);
      const response = await sandbox.process.executeCommand(
        args.command,
        args.cwd ?? WORKSPACE,
        undefined,
        COMMAND_TIMEOUT_SECONDS,
      );

      const { text, truncated } = clip(response.result ?? "");
      await ctx.runMutation(internal.work.finishReceipt, {
        id: receiptId,
        exitCode: response.exitCode,
        output: text,
        truncated,
      });

      return { exitCode: response.exitCode, output: text, truncated };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.work.finishReceipt, {
        id: receiptId,
        error: message.slice(0, 1000),
      });
      return { exitCode: null, output: "", truncated: false, error: message };
    }
  },
});

export const readFile = internalAction({
  args: { path: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ path: string; text?: string; truncated?: boolean; error?: string }> => {
    try {
      const sandbox = await open(ctx);
      const buffer = await sandbox.fs.downloadFile(resolvePath(args.path));
      const truncated = buffer.length > MAX_FILE_BYTES;
      return {
        path: args.path,
        text: buffer.subarray(0, MAX_FILE_BYTES).toString("utf8"),
        truncated,
      };
    } catch (error) {
      return {
        path: args.path,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

export const writeFile = internalAction({
  args: { path: v.string(), text: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ path: string; bytes?: number; error?: string }> => {
    try {
      if (Buffer.byteLength(args.text, "utf8") > MAX_FILE_BYTES) {
        return { path: args.path, error: "File is over the 256 KB limit." };
      }
      const sandbox = await open(ctx);
      const target = resolvePath(args.path);
      const dir = target.slice(0, target.lastIndexOf("/"));
      if (dir) await sandbox.process.executeCommand(`mkdir -p ${dir}`);
      await sandbox.fs.uploadFile(Buffer.from(args.text, "utf8"), target);
      return { path: args.path, bytes: Buffer.byteLength(args.text, "utf8") };
    } catch (error) {
      return {
        path: args.path,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

export const listFiles = internalAction({
  args: { path: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ path: string; entries?: string[]; error?: string }> => {
    try {
      const sandbox = await open(ctx);
      const target = resolvePath(args.path ?? ".");
      const files = await sandbox.fs.listFiles(target);
      return {
        path: target,
        entries: files.map((f) => {
          const record = f as unknown as Record<string, unknown>;
          const name = String(record.name ?? "");
          return record.isDir === true ? `${name}/` : name;
        }),
      };
    } catch (error) {
      return {
        path: args.path ?? WORKSPACE,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

/** Everything is relative to the workspace, and nothing escapes it. */
function resolvePath(path: string): string {
  const cleaned = path.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts: string[] = [];
  for (const segment of cleaned.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length > 0 ? `${WORKSPACE}/${parts.join("/")}` : WORKSPACE;
}

export const destroy = internalAction({
  args: {},
  returns: v.string(),
  handler: async (ctx): Promise<string> => {
    const existingId: string | null = await ctx.runQuery(
      internal.installation.getSandboxId,
      {},
    );
    if (!existingId) return "There was no sandbox.";

    try {
      requireKey();
      const daytona = new Daytona();
      const sandbox = await daytona.get(existingId);
      await daytona.delete(sandbox);
    } catch (error) {
      return `Could not delete it: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }

    await ctx.runMutation(internal.installation.setSandboxId, {
      sandboxId: undefined,
    });
    return "Sandbox deleted. The next command builds a fresh one.";
  },
});
