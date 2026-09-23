import { defineEval } from "./eval";
import { equals, includes, similarity } from "./expect";
import { deleteMemoriesContaining, inventedWord, memoriesContaining } from "./fixtures";

export default defineEval({
  description: "Remembers a fact in one chat, recalls it in a fresh one, then forgets it when asked.",
  tags: ["memory"],
  timeoutMs: 10 * 60_000,
  async test(t) {
    const name = inventedWord();
    t.cleanup(() => deleteMemoriesContaining(t.perry, name));

    const stored = await t.send(`This is an automated test. Please remember this for later: my houseplant is called ${name}.`);
    t.calledTool("remember", stored);

    // A fresh chat, so the name can only come from memory.
    const recalled = await t.send("This is an automated test. What is my houseplant called? Reply with just its name.");
    t.check(recalled.message, includes(name));
    t.check(recalled.message.trim(), similarity(name)).label("just the name");

    const forgot = await t.send(
      "This is an automated test, and I confirm the deletion: forget the memory about my houseplant's name. Don't ask me again.",
      { chat: recalled.chatId },
    );
    t.calledTool("forget", forgot);
    t.check(await memoriesContaining(t.perry, name), equals([])).label("gone from memory");
  },
});
