# Scroll: what people are posting about a topic, across platforms

Mani (21 Nov 2026): build treg's open-source "doomscroll" idea into Perry, on Perry's own
internet layer and free sources, with keyed sources optional. Failure cases written before
the tests and the code.

## Merge, rank, dedupe, seen (merge.test.ts)

- A post older than the window is kept, or a post with no date is dropped instead of kept
  at middling freshness.
- Dates in the shapes providers use are misread: unix seconds, unix milliseconds, digit
  strings, ISO with Z, RFC 2822 (RSS), "3 hours ago".
- Counts in the shapes providers use are misread: "110,617 views", "1.2K", "3M", booleans.
- The row list is not found in a provider's answer (`output.videos[].aweme_info`, a Reddit
  listing's `data.children[].data`), or a nested list (an Instagram reel's comments) is taken
  for it.
- A Reddit row links to its image instead of its thread; a TikTok or X link keeps its
  tracking query; a relative Reddit permalink is not made absolute.
- A big platform's numbers drown a quiet one (1k TikTok likes outrank the best HN story),
  or a quiet platform's best outranks a viral clip (no absolute reach).
- The same link twice, or the same text under two links, is shown twice; the better scored
  copy is the one dropped.
- A post shown in an earlier run of the same topic is shown again; a different topic shares
  its seen set; the counts of dropped old, duplicate and already seen posts are wrong.

## Sources (adapters.test.ts, recorded fixtures, no network)

- Hacker News, Reddit (subreddit top and search), RSS/Atom and YouTube rows are not
  normalised into the same post shape, with links, authors, dates and engagement.
- A source with no key is called anyway, faked, or silently missing from the coverage line
  instead of "not set up" with how to set it up.
- A keyed source sends its key anywhere but its own API host, or the key reaches the result.
- A failing request is retried more than once, or a 4xx is retried at all; one failing
  subreddit or feed loses the rows the others returned.
- One slow source holds up the whole run past its deadline.
- YouTube runs without a connected account, picks one of several accounts on its own, or
  sends arguments its discovered schema does not take.
- Product Hunt's day of launches is returned whole instead of the ones about the topic.

## End to end (run.mjs, isolated PERRY_HOME, real backend over SQLite)

- `internet_scroll` is not offered to the owner's chats over MCP, or is offered to a chat
  with someone else.
- Its result is not marked as from outside (untrusted), so a post could steer the turn.
- A second run of the same topic returns what the first one showed; a different topic does.
- The coverage line does not name each platform with its count, its failure or "not set
  up", nor the dropped old, duplicate and already seen counts.
- A key saved in Logins & secrets is not picked up, or its value appears in the result.
- The seen store grows without bound: topics never cleaned up, keys per topic never capped.
- The scroll skill is not installed into the skills folder, overwrites a copy the owner
  changed, or is not updated when Perry's own copy changes.
- A daily job set up for a scroll cannot run it, or says something when nothing new
  cleared the bar.
