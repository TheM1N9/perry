// Failure inventory: failure-cases.md. The real backend over SQLite, the owner's MCP endpoint, a job's
// turn claimed by a runner, Perry's skills folder in a temporary PERRY_HOME. The scheduler is stopped
// and the internet is the recorded fixtures in ./fixtures, served through lib/scroll/net.ts's transport.
// pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/scroll/run.mjs <outDir>
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

if (!process.argv[2]) throw new Error("Pass a disposable output directory");
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2]);
mkdirSync(out, { recursive: true });
const report = { checkedAt: new Date().toISOString(), passed: false, cases: [], sample: null };
const save = () => writeFileSync(join(out, "result.json"), JSON.stringify(report, null, 2) + "\n");
save();
const scratch = mkdtempSync(join(tmpdir(), "perry-scroll-"));
process.env.PERRY_HOME = scratch;
process.env.DASHBOARD_KEY = "synthetic-scroll-key";
process.env.PERRY_CREDENTIAL_KEY = "37".repeat(32);
process.env.TELEMETRY_DISABLED = "true";
for (const name of ["COMPOSIO_API_KEY", "X_BEARER_TOKEN", "SCRAPECREATORS_API_KEY", "PRODUCT_HUNT_TOKEN", "TREG_TOKEN", "REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"]) delete process.env[name];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => { throw new Error(`External IO disabled for the scroll replay: ${url}`); };

const [{ Runtime }, { default: schema }, { modules }, { default: http }, { transport }, { GUEST_TOOLS }, { installCoreSkills }] = await Promise.all([
  import("../../server/runtime.ts"), import("../../convex/schema.ts"), import("../../server/modules.ts"), import("../../convex/http.ts"),
  import("../../convex/lib/scroll/net.ts"), import("../../convex/lib/engines.ts"), import("../../runner/core-skills.ts"),
]);

// The recorded answers, moved to now: they were recorded at FIXTURE_NOW.
const FIXTURE_NOW = 1_795_200_000;
const now = Math.floor(Date.now() / 1000);
const shift = now - FIXTURE_NOW;
const fixture = name => JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
const hn = fixture("hackernews.json");
for (const hit of hn.hits) { hit.created_at_i += shift; hit.created_at = new Date(hit.created_at_i * 1000).toISOString(); }
const reddit = fixture("reddit.json");
for (const listing of [reddit.top, reddit.search]) for (const child of listing.data.children) child.data.created_utc += shift;
const keyed = fixture("keyed.json");
for (const tweet of keyed.x.data) tweet.created_at = new Date(Date.parse(tweet.created_at) + shift * 1000).toISOString();
for (const entry of keyed.tiktok.search_item_list) entry.aweme_info.create_time += shift;
// Feeds recorded at their own times, moved the same way.
const text = name => readFileSync(join(here, "fixtures", name), "utf8");
const moved = (xml, recordedAt) => xml
  .replace(/<pubDate>([^<]+)<\/pubDate>/g, (_all, date) => `<pubDate>${new Date(Date.parse(date) + (now - recordedAt) * 1000).toUTCString()}</pubDate>`)
  .replace(/<(published|updated)>([^<]+)<\/\1>/g, (_all, tag, date) => `<${tag}>${new Date(Date.parse(date) + (now - recordedAt) * 1000).toISOString()}</${tag}>`);
const lobstersRecorded = fixture("lobsters.json");
const googleNews = moved(text("google-news.xml"), lobstersRecorded._recordedAt);
const redditFeed = moved(text("reddit-top.xml"), FIXTURE_NOW);
const productHuntFeed = moved(text("producthunt-feed.xml"), lobstersRecorded._recordedAt);
const hits = [];
const answer = body => ({ status: 200, body: JSON.stringify(body), headers: {} });
transport.get = async (url) => {
  hits.push({ via: "get", url });
  const { hostname, pathname } = new URL(url);
  if (hostname === "hn.algolia.com") return answer(hn);
  if (hostname === "lobste.rs" && pathname === "/hottest.json") return answer(lobstersRecorded.hottest);
  if (hostname === "lobste.rs" && pathname === "/newest.json") return answer(lobstersRecorded.newest);
  return { status: 404, body: "{}", headers: {} };
};
// What Perry's internet layer reads feeds with (lib/internet.ts): Google News and Product Hunt.
transport.raw = async (url) => {
  hits.push({ via: "raw", url });
  const { hostname, pathname } = new URL(url);
  const page = (body, contentType) => ({ url, status: 200, body, contentType, challenged: false });
  if (hostname === "news.google.com" && pathname === "/rss/search") return page(googleNews, "application/xml");
  if (hostname === "www.producthunt.com" && pathname === "/feed") return page(productHuntFeed, "application/atom+xml");
  return { url, status: 404, body: "", contentType: "", challenged: false };
};
transport.send = async (url, init) => {
  hits.push({ via: "send", url, headers: init.headers });
  const { hostname, pathname } = new URL(url);
  if (hostname === "www.reddit.com" && pathname.endsWith("/top.rss")) return { status: 200, body: redditFeed, headers: {} };
  if (hostname === "api.x.com") return answer(keyed.x);
  if (hostname === "treg.to" && pathname === "/call/treg.tiktok.search.videos") return { ...answer({ output: { videos: keyed.tiktok.search_item_list }, _treg: { charged_micro: 1000 } }), headers: { "x-treg-cost-micro": "1000" } };
  return { status: 404, body: "{}", headers: {} };
};

const sql = new DatabaseSync(":memory:");
const runtime = new Runtime(sql, schema, modules, { storageDir: join(scratch, "storage"), http });
await runtime.stop();
const call = async (name, args = {}) => (await runtime.call(name, args, { internal: true })).value;
const insert = (table, doc) => runtime.exclusive(() => runtime.store.insert(table, doc));
const get = id => runtime.exclusive(() => runtime.store.get(id));
const patch = (id, doc) => runtime.exclusive(() => runtime.store.patch(id, doc));
const all = table => runtime.exclusive(() => runtime.store.query(table).collect());
const token = "synthetic-scroll-runner";
let rpc = 0;
let activeTurn;
const rawMcp = async (method, params = {}) => {
  const response = await runtime.runHttp("/mcp", new Request("http://perry.test/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-perry-turn": activeTurn._id, "x-perry-grant": activeTurn.mcpGrant }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method, params }) }));
  return await response.json();
};
const mcp = async (method, params = {}) => {
  const body = await rawMcp(method, params);
  assert.ok(!body.error, JSON.stringify(body));
  return body.result;
};
const tool = async (name, args) => {
  const result = await mcp("tools/call", { name, arguments: args });
  const text = result?.content?.[0]?.text ?? "null";
  return { text, value: JSON.parse(text) };
};
const scroll = args => tool("internet_scroll", args);
const check = async (name, run) => {
  try { await run(); report.cases.push({ name, passed: true }); }
  catch (error) { report.cases.push({ name, passed: false, error: String(error?.stack ?? error) }); }
  save();
};

try {
  const at = Date.now();
  await insert("installation", { defaultEngine: "codex", defaultAccess: "supervised", onboarding: "skipped", claimedAt: at, createdAt: at });
  const runner = await insert("runners", { name: "Synthetic runner", token, createdAt: at, lastSeenAt: at, engines: [{ kind: "codex", installed: true, signedIn: true, auth: {}, models: [], updatedAt: at }] });
  const owner = await insert("conversations", { channel: "web", externalId: "scroll-owner", threadId: "scroll-owner-thread", createdAt: at });
  const ownerTurn = await insert("codexTurns", { runnerId: runner, conversationId: owner, status: "queued", prompt: "What is the internet saying about AI hiring?", engine: "codex", createdAt: at });
  const ownerClaim = await call("codex:claimTurn", { token, id: ownerTurn });
  assert.ok(ownerClaim);
  activeTurn = ownerClaim;
  const topic = "AI hiring";
  const free = { topic, window: "24h", searches: ["AI hiring", "AI recruiter"], subreddits: ["cscareerquestions"], platforms: ["hackernews", "reddit"] };

  await check("internet_scroll is offered to the owner's turns and never to a chat with someone else", async () => {
    const listed = await mcp("tools/list");
    const entry = listed.tools.find(item => item.name === "internet_scroll");
    assert.ok(entry, "listed for the owner");
    assert.ok(entry.inputSchema.properties.topic && entry.inputSchema.properties.window && entry.inputSchema.properties.includeSeen);
    assert.ok(!GUEST_TOOLS.includes("internet_scroll"));
    await patch(ownerTurn, { status: "done", finishedAt: Date.now() });
    const contact = await insert("contacts", { channel: "telegram", externalId: "5550", kind: "person", name: "Sam", status: "allowed", createdAt: at, updatedAt: at });
    const guest = await insert("conversations", { channel: "telegram", externalId: "5550", threadId: "scroll-guest-thread", contactId: contact, createdAt: at });
    const guestTurn = await insert("codexTurns", { runnerId: runner, conversationId: guest, status: "queued", prompt: "what's new on AI hiring?", engine: "codex", createdAt: at });
    activeTurn = await call("codex:claimTurn", { token, id: guestTurn });
    assert.ok(activeTurn);
    const guestTools = (await mcp("tools/list")).tools.map(item => item.name);
    assert.ok(!guestTools.includes("internet_scroll"), "a chat with someone else does not get it");
    try {
      const refused = await rawMcp("tools/call", { name: "internet_scroll", arguments: { topic } });
      assert.match(refused.error?.message ?? "", /Unknown tool: internet_scroll/, JSON.stringify(refused));
      assert.equal(hits.length, 0, "nothing was fetched for the guest");
    } finally {
      await patch(guestTurn, { status: "done", finishedAt: Date.now() });
      await patch(ownerTurn, { status: "running", finishedAt: undefined });
      activeTurn = ownerClaim;
    }
  });

  await check("every keyless source in one scroll: ranked posts, marked untrusted, the turn marked as having read outside, every platform in the coverage line", async () => {
    const { value } = await scroll({ topic: "AI hiring across the web", window: "24h", searches: ["AI hiring", "AI recruiter"], subreddits: ["cscareerquestions", "recruitinghell"] });
    assert.match(value.untrusted, /data/);
    const all = value.result;
    report.sample = { coverage: all.coverage, sources: all.sources, posts: all.posts.slice(0, 6) };
    assert.ok(all.posts.every((post, index) => index === 0 || all.posts[index - 1].score >= post.score), "best first");
    for (const expected of [/^hackernews 3 · reddit 2 · lobsters 0 \(none of its 16 latest stories is about the topic\) · youtube not set up · news 6 · x not set up · tiktok not set up · instagram not set up · producthunt 0 \(none of its 6 latest launches is about the topic\) · rss skipped \(no feeds given\) · /, /, 1 too old, 0 already seen$/]) assert.match(all.coverage, expected);
    assert.match(all.sources.find(row => row.platform === "youtube").note, /Connect YouTube in Apps & skills/);
    assert.equal(all.sources.find(row => row.platform === "producthunt").provider, "Product Hunt feed", "free without a token");
    assert.match(all.sources.find(row => row.platform === "x").note, /Logins & secrets/);
    assert.ok(all.posts.some(post => post.platform === "news" && post.author === "HR Brew"));
    assert.equal(all.nothingNew, false);
    assert.equal(all.shownKeys, undefined, "what it remembers is not handed to the agent");
    assert.ok((await get(ownerTurn)).outsideAt, "what it read counts as from outside");
    const reddit = hits.filter(hit => new URL(hit.url).hostname === "www.reddit.com");
    assert.equal(reddit.length, 1, "one Reddit request a run");
    assert.match(reddit[0].headers["user-agent"], /^perry-scroll\/1\.0/);
    assert.ok(hits.every(hit => ({ get: ["hn.algolia.com", "lobste.rs"], raw: ["news.google.com", "www.producthunt.com"], send: ["www.reddit.com"] })[hit.via].includes(new URL(hit.url).hostname)), "keyless hosts only");
  });

  let first;
  await check("a repeat run of the topic returns only what is new, then nothing; another topic starts fresh", async () => {
    first = (await scroll({ ...free, limit: 3 })).value.result;
    assert.equal(first.posts.length, 3);
    assert.match(first.coverage, /^hackernews 3 · reddit 2 · \d+ duplicates?, 1 too old, 0 already seen$/);
    const shown = new Set(first.posts.map(post => post.url));
    const second = (await scroll({ ...free, limit: 3 })).value.result;
    assert.equal(second.posts.length, 2, "the two of five not shown yet");
    assert.ok(second.posts.every(post => !shown.has(post.url)), "nothing shown before");
    assert.match(second.coverage, / 3 already seen$/);
    const third = (await scroll({ ...free, limit: 50 })).value;
    assert.equal(third.result.posts.length, 0);
    assert.equal(third.result.nothingNew, true);
    assert.match(third.result.coverage, /hackernews 0 \(nothing new since the last run\)/);
    assert.match(third.result.note, /Nothing new/);
    const seenRow = (await all("scrollSeen")).find(row => /^ai-hiring-[0-9a-f]{8}$/.test(row.topic));
    assert.equal(seenRow.keys.length, 5);
    const other = (await scroll({ ...free, topic: "AI jobs" })).value.result;
    assert.equal(other.posts.length, 5, "a different topic has its own memory");
    const again = (await scroll({ ...free, includeSeen: true, limit: 2 })).value.result;
    assert.equal(again.posts.length, 2, "asked to, it shows them again");
  });

  await check("keys saved in Logins & secrets switch on X and treg, go only to their own API, and never appear in the result", async () => {
    await call("vault:save", { label: "X API", value: "synthetic-x-bearer-0123456789", by: "owner" });
    await call("vault:save", { label: "treg", value: "synthetic-treg-token-0123456789", by: "owner" });
    hits.length = 0;
    const { text, value } = await scroll({ topic: "AI hiring keyed", window: "24h", searches: ["AI hiring"], platforms: ["x", "tiktok", "instagram", "producthunt"] });
    const result = value.result;
    const x = hits.find(hit => hit.url.startsWith("https://api.x.com/"));
    assert.equal(x.headers.authorization, "Bearer synthetic-x-bearer-0123456789");
    const viaTreg = hits.find(hit => hit.url === "https://treg.to/call/treg.tiktok.search.videos");
    assert.equal(viaTreg.headers["x-treg-token"], "synthetic-treg-token-0123456789");
    assert.ok(hits.every(hit => hit.via === "send" || new URL(hit.url).hostname === "www.producthunt.com"), "keyed requests go out as keyed; Product Hunt's feed needs none");
    assert.equal(result.sources.find(row => row.platform === "x").provider, "X API");
    assert.equal(result.sources.find(row => row.platform === "tiktok").provider, "treg");
    assert.match(result.coverage, /^x 2 · tiktok 2 via treg · instagram failed \(HTTP 404\) · producthunt 0 \(none of its 6 latest launches is about the topic\) · /);
    assert.match(result.coverage, /\$0\.001 on treg$/);
    assert.ok(result.posts.some(post => post.url === "https://x.com/hiringlead/status/1859100000000000001"));
    assert.ok(!text.includes("synthetic-x-bearer-0123456789") && !text.includes("synthetic-treg-token-0123456789"));
  });

  await check("the seen store keeps at most 2,500 posts a topic and lets a topic idle for months go", async () => {
    const keys = Array.from({ length: 3000 }, (_, index) => `https://example.com/post/${index}`);
    await insert("scrollSeen", { topic: "long-forgotten", keys: ["https://example.com/old"], updatedAt: Date.now() - 100 * 86_400_000 });
    await call("scroll:remember", { topic: "busy-topic", keys });
    const rows = await all("scrollSeen");
    const busy = rows.find(row => row.topic === "busy-topic");
    assert.equal(busy.keys.length, 2500);
    assert.equal(busy.keys.at(-1), "https://example.com/post/2999");
    assert.equal(busy.keys[0], "https://example.com/post/500");
    assert.ok(!rows.some(row => row.topic === "long-forgotten"));
    await call("scroll:remember", { topic: "busy-topic", keys: ["https://example.com/post/600"] });
    const again = (await all("scrollSeen")).find(row => row.topic === "busy-topic");
    assert.equal(again.keys.length, 2500);
    assert.equal(again.keys.at(-1), "https://example.com/post/600", "shown again, it moves to the newest");
  });

  await check("the scroll skill is installed in the skills folder, kept up to date, and an owner's change or removal is respected", async () => {
    const skills = join(scratch, "skills");
    const shipped = readFileSync(resolve(here, "../../skills/scroll/SKILL.md"), "utf8");
    const installed = join(skills, "scroll", "SKILL.md");
    const shippedNames = readdirSync(resolve(here, "../../skills"), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(resolve(here, "../../skills", entry.name, "SKILL.md")))
      .map(entry => entry.name).sort();
    assert.deepEqual(installCoreSkills(undefined, skills).sort(), shippedNames);
    assert.equal(readFileSync(installed, "utf8"), shipped);
    assert.match(shipped, /^name: scroll$/m);
    assert.ok(!/—/.test(shipped), "no em dashes in the skill");
    assert.deepEqual(installCoreSkills(undefined, skills), [], "unchanged, nothing to do");
    writeFileSync(installed, shipped.replace("# Scroll", "# Scroll (an older Perry's copy)"));
    assert.deepEqual(installCoreSkills(undefined, skills), ["scroll"], "Perry's own copy is updated");
    assert.equal(readFileSync(installed, "utf8"), shipped);
    // The owner's copy may quote the marker in its body (an example); only its frontmatter says whose it is.
    const owners = shipped.replace(/^  perry: core\r?\n/m, "").replace("# Scroll", "# Scroll, my way\n\n```yaml\nmetadata:\n  perry: core\n```");
    writeFileSync(installed, owners);
    assert.deepEqual(installCoreSkills(undefined, skills), []);
    assert.equal(readFileSync(installed, "utf8"), owners, "the owner's version stays");
    rmSync(join(skills, "scroll"), { recursive: true, force: true });
    assert.deepEqual(installCoreSkills(undefined, skills), []);
    assert.ok(!existsSync(installed), "a removed skill stays removed");
  });

  await check("a daily scroll job runs the tool in its own turn and, with nothing new, delivers nothing", async () => {
    // The owner asks for it in a new message: a turn that read posts may not set up a job on its own (issue #136).
    await patch(ownerTurn, { status: "done", finishedAt: Date.now() });
    const askTurn = await insert("codexTurns", { runnerId: runner, conversationId: owner, status: "queued", prompt: "Make that a daily 9am digest, only when there is something new.", engine: "codex", createdAt: Date.now() });
    activeTurn = await call("codex:claimTurn", { token, id: askTurn });
    assert.ok(activeTurn);
    const prompt = "Use the scroll skill. Run internet_scroll on the topic 'AI hiring' for the last 24h with the searches 'AI hiring' and 'AI recruiter' and the subreddit cscareerquestions. Write the digest. Only tell me if something new cleared the bar.";
    const made = (await tool("create_job", { name: "AI hiring scroll", schedule: "0 9 * * *", prompt })).value;
    assert.ok(made.id, JSON.stringify(made));
    const job = await get(made.id);
    assert.equal(job.schedule, "0 9 * * *");
    assert.equal(job.origin, owner);
    await patch(askTurn, { status: "done", finishedAt: Date.now() });
    await call("jobs:run", { id: made.id });
    const conversationId = (await get(made.id)).conversationId;
    const conversation = await get(conversationId);
    const scheduled = sql.prepare("SELECT args FROM _scheduled WHERE name = 'brain:handleTurn' ORDER BY createdAt DESC").all().map(row => JSON.parse(row.args)).find(args => args.externalId === conversation.externalId);
    assert.ok(scheduled, "the job schedules its turn");
    await call("brain:handleTurn", scheduled);
    const queued = (await all("codexTurns")).filter(turn => turn.conversationId === conversationId && turn.status === "queued");
    assert.equal(queued.length, 1);
    const claimed = await call("codex:claimTurn", { token, id: queued[0]._id });
    assert.ok(claimed);
    activeTurn = claimed;
    assert.match(claimed.prompt, /internet_scroll on the topic 'AI hiring'/);
    assert.match(claimed.prompt, /reply with exactly NOTHING/);
    const run = (await scroll({ ...free, platforms: ["hackernews", "reddit"] })).value.result;
    assert.equal(run.nothingNew, true, `everything was shown in the chat earlier: ${run.coverage}`);
    assert.match(run.note, /quiet word/);
    const before = sql.prepare("SELECT COUNT(*) AS n FROM _scheduled WHERE name = 'notify:deliver'").get().n;
    await call("codex:finishTurn", { token, id: claimed._id, response: "NOTHING" });
    await call("codex:finalizeTurn", { id: claimed._id });
    assert.equal((await get(made.id)).lastResult, "NOTHING");
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM _scheduled WHERE name = 'notify:deliver'").get().n, before, "nothing is delivered");
  });

  report.passed = report.cases.length > 0 && report.cases.every(item => item.passed);
  save();
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.map(item => `${item.passed ? "ok" : "FAIL"} ${item.name}${item.error ? `\n${item.error}` : ""}`) }, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  await runtime.stop(); sql.close(); globalThis.fetch = originalFetch;
  const absolute = resolve(scratch);
  if (absolute.startsWith(resolve(tmpdir()) + sep) && absolute.includes("perry-scroll-")) rmSync(absolute, { recursive: true, force: true });
}
