# Scroll

"Catch me up on X", "what is the internet saying about X", "what did I miss": Perry's `scroll`
skill (skills/scroll/SKILL.md) plans a few searches and the places the topic lives, calls
`internet_scroll` once, reads what comes back and writes a digest of stories with links, the
clips worth watching, the mood, and a coverage line.

`internet_scroll` (convex/lib/scroll) searches every platform it can in parallel, drops posts
older than the window (6h, 24h, 3d or 1w), duplicates and what an earlier run of the same topic
already showed, and ranks the rest by engagement within each platform, absolute reach and
freshness. The ranking and the workflow are adapted from treg's open-source doomscroll skill
(Apache-2.0, see NOTICE). Perry does not depend on treg.

## Sources

| Platform | Free | How it is read |
| --- | --- | --- |
| Hacker News | yes | Algolia's public search API |
| Reddit | yes, where Reddit allows it | its public Atom feeds with a User-Agent naming Perry: one request a run (every subreddit in one multireddit feed, or one search), since Reddit allows an anonymous reader about one a minute; no scores. With a Reddit app, Reddit's API, with scores |
| Lobsters | yes | its public hottest and newest JSON, stories about the topic |
| News | yes | Google News's public RSS search, one feed per search, limited to the window |
| YouTube | yes, with an account | the YouTube account connected in Apps & skills → Connectors: YOUTUBE_SEARCH_YOU_TUBE, read-only, the way run_action reaches it, published in the window, most viewed first. Its answer has no counts, so YouTube's order breaks ties |
| Product Hunt | yes | its public Atom feed, launches about the topic; with a developer token, its GraphQL API with votes |
| RSS and Atom | yes | the feeds the agent passes, read by Perry's internet layer |
| X | needs a key | X's API (recent search) with a bearer token, or treg |
| TikTok, Instagram | needs a key | ScrapeCreators, or treg |

Lobsters and Product Hunt have no search, so a post is kept only when every meaningful word of
the topic or of one search is in it (`aboutTopic` in types.ts). Signed-in scraping of X,
Instagram or TikTok is deliberately not done.

Keys are logins in **Settings → Logins & secrets**, found by name. The value is the key:

| Name | What |
| --- | --- |
| `X API` | an X API bearer token |
| `ScrapeCreators` | a ScrapeCreators API key |
| `Product Hunt` | a Product Hunt developer token |
| `treg` | a treg token; serves X, TikTok, Instagram and YouTube for platforms with no key of their own, billed per call by treg |
| `Reddit app` | a Reddit app: its client id as the username, its secret as the password |

The same keys can come from the environment instead (`X_BEARER_TOKEN`, `SCRAPECREATORS_API_KEY`,
`PRODUCT_HUNT_TOKEN`, `TREG_TOKEN`, `REDDIT_CLIENT_ID` with `REDDIT_CLIENT_SECRET`). A key is sent
only to its own provider's API host over https (convex/lib/scroll/net.ts) and never appears in a
result. A platform with no key is listed as "not set up", never filled in with guesses.

Reddit turns away anonymous readers on some networks: its feeds answer an empty "Not Found"
(HTTP 404), its JSON a 403. The coverage line then says so and names the Reddit app that reads
through Reddit's API instead.

## Behaviour

- Each platform is asked by the first source set up for it. A failing request is tried again at
  most once, and only for a server failure or no connection; a refusal or rate limit is final.
  One failing subreddit or feed keeps the rest. A run has a 40 second deadline.
- What a run showed is kept per topic in the `scrollSeen` table (convex/scroll.ts), so a repeat or
  scheduled run returns only what is new. A topic keeps its latest 2,500 posts and is forgotten
  after 90 days without a run. `includeSeen` shows them again.
- A daily scroll is a job whose prompt says to tell the owner only when something new cleared
  the bar; with nothing new it replies with the job's quiet word and delivers nothing.
- The skill ships in skills/ and the runner copies it into the skills folder when it starts
  (runner/core-skills.ts). A copy whose frontmatter still says `perry: core` is updated with Perry;
  remove that line to keep your own changes. A removed copy stays removed.

## Adding a source

A source is one small file in convex/lib/scroll/sources/ exporting a `Source`: its name, the
platforms it serves, the key it needs (add it to `KEYS` in types.ts), and a `fetch` that turns
the plan into posts. Add it to `SOURCES` in index.ts, ahead of the sources it should be preferred
to. If it sends a key, add its API host to `KEY_HOSTS` in net.ts.

## Checks

- `pnpm test`: the merge, rank, dedupe and seen rules (artifacts/scroll/merge.test.ts, ported from
  the reference script's selftest) and every source against recorded answers
  (artifacts/scroll/adapters.test.ts, fixtures in artifacts/scroll/fixtures). No network.
- `artifacts/scroll/run.mjs`: end to end through Perry's MCP endpoint on the real backend over
  SQLite in a temporary PERRY_HOME, with the internet replaced by the fixtures. Failure cases:
  artifacts/scroll/failure-cases.md.
