import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";

/**
 * Where Agent P's commands actually run.
 *
 * Two targets, and the difference is entirely about what is at risk:
 *
 *   sandbox   A Daytona box that exists for this install and nothing else. A
 *             bad command destroys a container. Nothing of yours is in it.
 *
 *   local     Your own laptop, desktop or Mac, through a runner you started
 *             and can stop. A bad command destroys your files. In exchange it
 *             can touch the things you actually care about.
 *
 * This file only routes. The safety on the local path lives on the machine
 * itself: the runner prints every command, asks before running it unless you
 * started it with --auto, confines itself to one directory, and refuses a
 * denylist outright. Approval belongs on the machine at risk, in a terminal
 * you control, not in a web page.
 */

const WAIT_TIMEOUT_MS = 120_000;
const POLL_MS = 400;

export type ComputeResult = {
  target: "sandbox" | "local" | "none";
  exitCode?: number | null;
  output?: string;
  truncated?: boolean;
  replayed?: boolean;
  error?: string;
  note?: string;
};

async function chosenTarget(ctx: ActionCtx): Promise<"sandbox" | "local"> {
  const install = await ctx.runQuery(internal.installation.get, {});
  return install?.computeTarget ?? "sandbox";
}

/**
 * Hand an operation to the runner and wait for it.
 *
 * The wait is a poll rather than a subscription because this is a Convex
 * action, not a client. Two minutes is generous: the runner may be sitting on
 * an approval prompt while its owner reads the command.
 */
async function viaRunner(
  ctx: ActionCtx,
  runner: Doc<"runners">,
  args: {
    kind: "exec" | "read" | "write" | "list";
    operationId: string;
    command?: string;
    path?: string;
    text?: string;
    cwd?: string;
  },
): Promise<ComputeResult> {
  const commandId: Id<"commands"> = await ctx.runMutation(
    internal.runner.enqueue,
    { runnerId: runner._id, ...args },
  );

  const deadline = Date.now() + WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));

    const command = await ctx.runQuery(internal.runner.getCommand, {
      commandId,
    });
    if (!command) break;

    if (command.status === "done") {
      return {
        target: "local",
        exitCode: command.exitCode ?? null,
        output: command.output ?? "",
        truncated: command.truncated ?? false,
      };
    }
    if (command.status === "denied") {
      // The runner says why: you declined it, it was outside the working
      // directory, or the denylist caught it. Those are different facts and
      // the agent should not be told the wrong one.
      return {
        target: "local",
        error: command.error ?? "Refused on your machine.",
      };
    }
    if (command.status === "error") {
      return { target: "local", error: command.error ?? "The runner failed." };
    }
  }

  await ctx.runMutation(internal.runner.abandonCommand, {
    commandId,
    error: "Timed out waiting for the runner.",
  });

  return {
    target: "local",
    error:
      "Your machine did not answer in two minutes. It may be asleep, the " +
      "runner may have stopped, or the approval prompt is still waiting.",
  };
}

async function noRunner(): Promise<ComputeResult> {
  return {
    target: "none",
    error:
      "This install is set to run commands on your own machine, but no " +
      "runner is connected. Start one with `pnpm run connect`, or switch the " +
      "target back to the cloud sandbox in Settings.",
  };
}

export const exec = internalAction({
  args: {
    command: v.string(),
    operationId: v.string(),
    cwd: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ComputeResult> => {
    const target = await chosenTarget(ctx);

    if (target === "local") {
      // Replay an existing receipt rather than running a second time. The
      // model retries more eagerly than it should, and a re-run `git push` is
      // not a retry, it is a second event.
      const prior = await ctx.runQuery(internal.runner.findByOperation, {
        operationId: args.operationId,
      });
      if (prior && (prior.status === "done" || prior.status === "denied")) {
        return {
          target: "local",
          exitCode: prior.exitCode ?? null,
          output: prior.output ?? "",
          truncated: prior.truncated ?? false,
          replayed: true,
          ...(prior.status === "denied"
            ? { error: prior.error ?? "Refused on your machine earlier." }
            : {}),
        };
      }

      const runner = await ctx.runQuery(internal.runner.liveRunner, {});
      if (!runner) return await noRunner();

      return await viaRunner(ctx, runner, { kind: "exec", ...args });
    }

    const result = await ctx.runAction(internal.sandbox.exec, args);
    return { target: "sandbox", ...result };
  },
});

export const readFile = internalAction({
  args: { path: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    target: string;
    path: string;
    text?: string;
    truncated?: boolean;
    error?: string;
  }> => {
    const target = await chosenTarget(ctx);

    if (target === "local") {
      const runner = await ctx.runQuery(internal.runner.liveRunner, {});
      if (!runner) {
        const missing = await noRunner();
        return { target: "none", path: args.path, error: missing.error };
      }
      const result = await viaRunner(ctx, runner, {
        kind: "read",
        operationId: `read:${args.path}:${Date.now()}`,
        path: args.path,
      });
      return {
        target: "local",
        path: args.path,
        text: result.output,
        truncated: result.truncated,
        error: result.error,
      };
    }

    const result = await ctx.runAction(internal.sandbox.readFile, args);
    return { target: "sandbox", ...result };
  },
});

export const writeFile = internalAction({
  args: { path: v.string(), text: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ target: string; path: string; bytes?: number; error?: string }> => {
    const target = await chosenTarget(ctx);

    if (target === "local") {
      const runner = await ctx.runQuery(internal.runner.liveRunner, {});
      if (!runner) {
        const missing = await noRunner();
        return { target: "none", path: args.path, error: missing.error };
      }
      const result = await viaRunner(ctx, runner, {
        kind: "write",
        operationId: `write:${args.path}:${Date.now()}`,
        path: args.path,
        text: args.text,
      });
      return {
        target: "local",
        path: args.path,
        bytes: result.error ? undefined : args.text.length,
        error: result.error,
      };
    }

    const result = await ctx.runAction(internal.sandbox.writeFile, args);
    return { target: "sandbox", ...result };
  },
});

export const listFiles = internalAction({
  args: { path: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    target: string;
    path: string;
    entries?: string[];
    error?: string;
  }> => {
    const target = await chosenTarget(ctx);

    if (target === "local") {
      const runner = await ctx.runQuery(internal.runner.liveRunner, {});
      if (!runner) {
        const missing = await noRunner();
        return { target: "none", path: args.path ?? ".", error: missing.error };
      }
      const result = await viaRunner(ctx, runner, {
        kind: "list",
        operationId: `list:${args.path ?? "."}:${Date.now()}`,
        path: args.path ?? ".",
      });
      return {
        target: "local",
        path: args.path ?? ".",
        entries: result.output ? result.output.split("\n").filter(Boolean) : undefined,
        error: result.error,
      };
    }

    const result = await ctx.runAction(internal.sandbox.listFiles, args);
    return { target: "sandbox", ...result };
  },
});

export const status = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    target: "sandbox" | "local";
    runner?: {
      name: string;
      platform?: string;
      hostname?: string;
      workdir?: string;
      autoApprove: boolean;
      online: boolean;
    };
    sandbox?: unknown;
    note?: string;
  }> => {
    const target = await chosenTarget(ctx);

    if (target === "local") {
      const runner = await ctx.runQuery(internal.runner.liveRunner, {});
      if (!runner) {
        return {
          target,
          note:
            "No machine is connected right now. Start the runner with " +
            "`pnpm run connect`, or switch to the cloud sandbox in Settings.",
        };
      }
      return {
        target,
        runner: {
          name: runner.name,
          platform: runner.platform,
          hostname: runner.hostname,
          workdir: runner.workdir,
          autoApprove: runner.autoApprove,
          online: true,
        },
      };
    }

    const sandbox = await ctx.runAction(internal.sandbox.status, {});
    return { target, sandbox };
  },
});
