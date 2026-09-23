import { defineEval } from "./eval";
import { includes } from "./expect";

export default defineEval({
  description: "Answers a comparison in clean Markdown that the chat can render.",
  tags: ["style"],
  async test(t) {
    const turn = await t.send("This is an automated test. Compare tea and coffee on caffeine, taste and price in a Markdown table, then give two tips as a bulleted list.");
    t.check(turn.message, includes(/^\s*\|?\s*:?-{3,}:?\s*\|/m)).label("table separator row");
    t.check(turn.message, includes(/^\s*[-*] \S/m)).label("bulleted list");
    t.judge(
      "The reply is well-formed Markdown: a table with a header row, a separator row and one row per aspect " +
      "(caffeine, taste, price), followed by a bulleted list of two tips, with no filler preamble or sign-off.",
    ).gate(0.7);
  },
});
