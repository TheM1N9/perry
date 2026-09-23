import { defineEval } from "./eval";
import { includes } from "./expect";
import { deleteMemoriesContaining, inventedWord } from "./fixtures";

export default defineEval({
  description: "Finds something said in an earlier chat with search_chats.",
  tags: ["tools", "chats"],
  timeoutMs: 8 * 60_000,
  async test(t) {
    const codeword = inventedWord();
    // Should Perry remember it anyway, the memory goes too.
    t.cleanup(() => deleteMemoriesContaining(t.perry, codeword));

    const earlier = await t.send(`This is an automated test. Don't save anything to memory. The codeword for this test is ${codeword}. Reply with just OK.`);
    t.notCalledTool("remember", earlier).soft();

    const later = await t.send("This is an automated test. In an earlier chat I told you the codeword for this test. Search our earlier chats for it and reply with just the codeword.");
    t.calledTool("search_chats", later);
    t.check(later.message, includes(codeword));
  },
});
