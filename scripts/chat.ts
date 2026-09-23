#!/usr/bin/env bun
/**
 * `pnpm chat [--chat <id>]` — talk to Perry from this terminal.
 *
 * A web chat like the dashboard's, over the same functions and the dashboard
 * key in .env.local, so it shows up in the dashboard too. The reply streams in
 * place; Ctrl+C stops it, keeping what it wrote, and a second Ctrl+C exits.
 * Commands: /new, /model [name], /quit.
 */

import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { api } from "../convex/_generated/api";
import { describeModels, parseModelCommand, pickModel } from "../convex/lib/commands";
import { bold, dim, red, yellow } from "./lib";
import { Perry, type ChatId } from "./perry-client";

const { values: flags } = parseArgs({ options: { chat: { type: "string" } } });

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/cli/dev/tui/turn-clock.ts
/**
 * One turn's wall clock and tokens: armed when a message is sent, fed the
 * run's usage, and settled exactly once for the line printed after the reply.
 */
class TurnClock {
  #startedAtMs?: number;
  #tokens?: number;

  arm(): void {
    this.#startedAtMs = Date.now();
    this.#tokens = undefined;
  }

  addUsage(tokens?: number): void {
    if (tokens !== undefined) this.#tokens = (this.#tokens ?? 0) + tokens;
  }

  /** The turn's elapsed time and tokens, or undefined when no turn was armed. */
  settle(): { elapsedMs: number; tokens?: number } | undefined {
    const startedAtMs = this.#startedAtMs;
    if (startedAtMs === undefined) return undefined;
    this.#startedAtMs = undefined;
    return { elapsedMs: Date.now() - startedAtMs, tokens: this.#tokens };
  }
}

/**
 * The reply as it is written. Codex sends the whole text so far, so a longer
 * version of the same text only prints what is new; anything else (it moved on
 * to a new message) erases what was shown and draws it again.
 */
class LiveText {
  private shown = "";

  update(text: string) {
    if (text.startsWith(this.shown)) {
      process.stdout.write(text.slice(this.shown.length));
    } else {
      const width = process.stdout.columns || 80;
      const rows = this.shown.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / width)), 0);
      process.stdout.write(`\r${rows > 1 ? `\x1b[${rows - 1}A` : ""}\x1b[0J${text}`);
    }
    this.shown = text;
  }
}

let perry: Perry;
try {
  perry = Perry.fromEnv();
} catch (error) {
  console.error(red(error instanceof Error ? error.message : String(error)));
  process.exit(1);
}

let chatId = flags.chat as ChatId | undefined;
/** The model picked before the chat exists; it goes with the first message. */
let draftModel: string | undefined;
/** The chat whose reply is being written, if one is. */
let replying: ChatId | undefined;
let interrupts = 0;
const clock = new TurnClock();

if (chatId) {
  const chat = await perry.getChat(chatId).catch(() => null);
  if (!chat) {
    console.error(red(`No web chat with id ${chatId}.`));
    process.exit(1);
  }
  console.log(`\n${bold(chat.title)}${chat.model ? dim(` · ${chat.model}`) : ""}`);
} else {
  console.log(`\n${bold("Perry")} ${dim("· a new chat")}`);
}
console.log(dim("/new starts a chat, /model [name] picks a model, /quit leaves. Ctrl+C stops a reply.\n"));

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `${bold("you")} › ` });

let exiting = false;
async function exit(): Promise<void> {
  if (exiting) return;
  exiting = true;
  rl.close();
  await perry.close();
  process.exit(0);
}

rl.on("SIGINT", () => {
  interrupts += 1;
  if (interrupts >= 2) {
    process.stdout.write("\n");
    void exit();
    return;
  }
  if (replying) {
    void perry.stop(replying).catch(() => {});
    return;
  }
  process.stdout.write(dim("\n(Ctrl+C again to exit)\n"));
  rl.prompt();
});

rl.on("line", (line) => {
  // Lines typed while a reply is being written are dropped.
  if (replying) return;
  interrupts = 0;
  void handle(line.trim()).catch((error) => console.log(red(error instanceof Error ? error.message : String(error)))).finally(() => rl.prompt());
});

rl.on("close", () => void exit());

async function handle(text: string): Promise<void> {
  if (!text) return;
  if (text === "/quit" || text === "/exit") return exit();
  if (text === "/new") {
    chatId = undefined;
    draftModel = undefined;
    console.log(dim("A new chat starts with your next message."));
    return;
  }
  const modelCommand = parseModelCommand(text);
  if (modelCommand) {
    const { codex: models } = await perry.convex.query(api.models.options, { key: perry.key });
    const picked = chatId ? (await perry.getChat(chatId)).model : draftModel;
    if (!modelCommand.name) return console.log(dim(describeModels(models, picked)));
    const choice = pickModel(models, modelCommand.name);
    if (choice.model && chatId) await perry.setModel(chatId, choice.model.id);
    else if (choice.model) draftModel = choice.model.id;
    console.log(dim(choice.reply));
    return;
  }

  const fresh = !chatId;
  chatId ??= await perry.createChat();
  if (fresh) console.log(dim(`chat ${chatId}`));
  replying = chatId;
  clock.arm();
  const live = new LiveText();
  // On its own line, so redrawing the reply never has to account for it.
  process.stdout.write(`${bold("perry")}\n`);
  try {
    const turn = await perry.send(chatId, text, { model: fresh ? draftModel : undefined, onText: (partial) => live.update(partial) });
    live.update(turn.message);
    process.stdout.write("\n");
    if (turn.error) console.log(red(turn.error));
    clock.addUsage(turn.run?.totalTokens);
    const settled = clock.settle()!;
    const summary = [
      `${(settled.elapsedMs / 1000).toFixed(1)}s`,
      settled.tokens !== undefined ? `${settled.tokens.toLocaleString()} tokens` : "tokens not reported",
      turn.run?.model,
      turn.toolCalls.length ? [...new Set(turn.toolCalls)].join(", ") : undefined,
      interrupts > 0 ? yellow("stopped") : undefined,
    ].filter(Boolean);
    console.log(dim(`  ${summary.join(" · ")}\n`));
  } finally {
    replying = undefined;
  }
}

rl.prompt();
