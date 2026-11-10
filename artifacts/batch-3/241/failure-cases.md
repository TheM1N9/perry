# Isolated parser/render verification failure cases (recorded before harness/code)

- Open fences may already parse correctly; appending fences can corrupt nested or literal code.
- Header-only or partial table delimiters may leak pipes/dashes or invent extra columns; escaped pipes, alignment, and one-column tables need coverage.
- Unmatched inline markers can flash; escapes, intraword underscores, completed emphasis, nested formatting, code literals, and literal punctuation must stay intact.
- Incomplete links/HTML must never acquire executable URLs or raw HTML; existing URL sanitization must still run.
- Static rendering must be byte-for-byte identical with the plugin disabled; checklist, note/skill links and code content/copy inputs must remain unchanged.
- Repairs must not visit historical blocks, keep cross-message state, recurse on their own output, or perform unbounded extra parsing of huge tails.
- Completion must remove all synthetic formatting immediately; no timer/animation state or extra leaf subscriptions.
- Fixture must not import runtime/bootstrap, use real configuration, write outside issue scratch, access network or run a server. Set synthetic env first and block network even though parser-only fixtures do not require it.

Harness scope: installed ReactMarkdown SSR pipeline, existing GFM/breaks and new remark helper. Actual Next/Perry UI, clipboard, note click handlers and browser acceptance remain coordinator-owned.
