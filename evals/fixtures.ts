import { randomInt } from "node:crypto";
import { api } from "../convex/_generated/api";
import type { Perry } from "../scripts/perry-client";

/** What the evals share: unique test data, and cleaning it out of memory. */

/** A made-up word no earlier chat or memory contains, so a match can only come from this run. */
export function inventedWord(): string {
  const syllables = ["ka", "lo", "mi", "ra", "tu", "ve", "zo", "ni", "pe", "su", "do", "fa"];
  const word = Array.from({ length: 4 }, () => syllables[randomInt(syllables.length)]).join("");
  return word[0]!.toUpperCase() + word.slice(1);
}

/** Current memories that contain `text`, in any case. Superseded ones are not searched. */
async function find(perry: Perry, text: string) {
  const found = await perry.convex.query(api.dashboard.listMemories, { key: perry.key, query: text });
  return found.filter((memory) => memory.text.toLowerCase().includes(text.toLowerCase()));
}

export async function memoriesContaining(perry: Perry, text: string): Promise<string[]> {
  return (await find(perry, text)).map((memory) => memory.text);
}

export async function deleteMemoriesContaining(perry: Perry, text: string): Promise<void> {
  for (const memory of await find(perry, text)) {
    await perry.convex.mutation(api.dashboard.deleteMemory, { key: perry.key, id: memory.id });
  }
}
