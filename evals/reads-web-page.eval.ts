import { defineEval } from "./eval";
import { includes } from "./expect";

export default defineEval({
  description: "Reads a URL with its read_page tool rather than guessing.",
  tags: ["tools", "web"],
  async test(t) {
    const turn = await t.send("This is an automated test. Read https://example.com and tell me the page's main heading, exactly as written.");
    t.calledTool("read_page", turn);
    t.check(turn.message, includes("Example Domain"));
  },
});
