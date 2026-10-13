import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";

// bun artifacts/github-token/run.ts <outDir>
// GitHub connected with a token the owner pastes, kept by Perry and checked
// with GitHub, in place of Composio's GitHub (convex/github.ts).
//
// No real GitHub and no model: GITHUB_API_BASE points Perry at a stand-in
// GitHub here, which knows one token and records every request, and the
// engine is the fake ACP agent playing Grok Build
// (artifacts/engine-acp/fake-agent.ts), which calls Perry's tools as told
// ("TOOLS [...]"). Everything else is real: a fresh Perry from the production
// build (`pnpm build` first) on a spare port, its own PERRY_HOME, the real
// runner, headless Chrome on Apps & skills → Connectors. No Composio key is
// set: GitHub must not need one.
//
// Ways it could fail, written down before the checks:
//   1. A wrong token reads as connected: kept anyway, or the page says
//      connected, or the agent's list_connectors lists GitHub as working.
//   2. A wrong token's error is lost: the page must say GitHub refused it,
//      where it was pasted.
//   3. A right token is refused, or connected without saying whose: the page
//      must name the account GitHub gave.
//   4. The token leaks: shown back on the page, returned by the backend, or
//      written into the chat or the agent's tool answers.
//   5. A token revoked at GitHub later still reads as connected, on the page
//      or to the agent; or the page offers no way to replace it.
//   6. The agent cannot reach GitHub: list_connectors without it, find_action
//      without its actions, run_action not reaching GitHub's API with the
//      token, or a list's next page lost.
//   7. A change is made on the word of something read from outside: after a
//      read in the same turn, GITHUB_REST_CHANGE must be held for the owner,
//      and go ahead in a turn of its own.
//   8. The token goes somewhere else: a path naming another host must be
//      refused before anything is sent.
//   9. Composio's GitHub is still reachable: connecting GitHub through Composio
//      and its triggers must point to the token instead.
//  10. Disconnecting leaves the token behind, or acts without asking.
//  11. Without Composio set up, GitHub is not on the page at all.
//  12. Any page throws: no uncaught errors in the browser.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/github-token/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

// --- The stand-in GitHub ---------------------------------------------------------------
const made = () => `github_pat_e2e${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
/** The token pasted first, revoked at GitHub later, and the one made to replace it. */
const GOOD = made();
const NEW = made();
const WRONG = "github_pat_e2e_not_a_real_token";
const gitHub = { valid: new Set([GOOD, NEW]), requests: [] as Array<{ method: string; path: string; token?: string; body?: unknown }>, issues: [] as Array<{ title: string }> };
const stub = createServer((request: IncomingMessage, response: ServerResponse) => {
  let raw = "";
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", () => {
    const url = new URL(request.url ?? "/", "http://stand-in");
    const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const body = raw ? JSON.parse(raw) : undefined;
    gitHub.requests.push({ method: request.method ?? "", path: `${url.pathname}${url.search}`, token, ...(body !== undefined ? { body } : {}) });
    const reply = (status: number, value: unknown, headers: Record<string, string> = {}) => { response.writeHead(status, { "content-type": "application/json", ...headers }); response.end(JSON.stringify(value)); };
    if (!token || !gitHub.valid.has(token)) return reply(401, { message: "Bad credentials", documentation_url: "https://docs.github.com/rest" });
    if (request.method === "GET" && url.pathname === "/user") return reply(200, { login: "octo-owner", id: 1, name: "Octo Owner" });
    if (request.method === "GET" && url.pathname === "/user/repos") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const repos = [{ full_name: "octo-owner/perry-notes", private: true }, { full_name: "octo-owner/dotfiles", private: false }];
      const next: Record<string, string> = page < repos.length ? { link: `<http://${request.headers.host}/user/repos?per_page=1&page=${page + 1}>; rel="next"` } : {};
      return reply(200, [repos[page - 1]], next);
    }
    if (request.method === "POST" && url.pathname === "/repos/octo-owner/perry-notes/issues") {
      gitHub.issues.push({ title: String(body?.title) });
      return reply(201, { number: 6 + gitHub.issues.length, title: body?.title, html_url: "https://github.com/octo-owner/perry-notes/issues/7" });
    }
    return reply(404, { message: "Not Found" });
  });
});
await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
const API = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;

let fakeHome = "";
const p = await perry({
  name: "github-token",
  outDir,
  runnerEnv: (home) => {
    fakeHome = join(home, "fake-grok");
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(fakeHome, "grok-signed-in"), "yes");
    mkdirSync(join(home, "no-codex"), { recursive: true });
    mkdirSync(join(home, "no-claude"), { recursive: true });
    return { PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`, FAKE_ACP_HOME: fakeHome, CODEX_HOME: join(home, "no-codex"), CLAUDE_CONFIG_DIR: join(home, "no-claude") };
  },
  env: { GITHUB_API_BASE: API },
});
const { KEY, BASE, call, check, notes, until, rows, getChat, messagesOf } = p;

const kept = () => rows("secrets").filter((row) => row.name === "PERRY_GITHUB_TOKEN");
type Connection = { state: string; login?: string; name?: string; error?: string };
const backend = () => call<Connection>("dashboard:getGitHub", { key: KEY });
/** What one of Perry's tools answered the fake agent, as the agent read it. */
const answered = (entry: Record<string, any>) => {
  const raw = String(entry.answer ?? "");
  const body = raw.trim().startsWith("{") ? raw : raw.split("\n").find((line) => line.startsWith("data:"))?.slice(5) ?? "{}";
  const text = (JSON.parse(body).result?.content ?? []).map((part: { text?: string }) => part.text ?? "").join("");
  try { return JSON.parse(text); } catch { return text; }
};
const toolCalls = () => p.fakeLog(fakeHome).filter((entry) => entry.tool);
/** Send the fake agent a message, wait for the turn, and give back what each tool answered in it, in order. */
async function turn(chat: string, text: string) {
  const before = toolCalls().length;
  await call("dashboard:sendChat", { key: KEY, id: chat, text });
  await until(async () => { const now = await getChat(chat); return !now.isRunning && toolCalls().length > before; }, `the turn "${text.slice(0, 50)}"`, 90);
  await sleep(500);
  return toolCalls().slice(before).map((entry) => ({ tool: String(entry.tool), args: entry.args, answer: answered(entry) }));
}
const tools = (calls: Array<[string, Record<string, unknown>]>) => `TOOLS ${JSON.stringify(calls)}`;

let ok = false;
try {
  p.start("server");
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  p.start("runner");
  await until(async () => (await call<Array<{ online: boolean; engines: Array<{ kind: string; signedIn: boolean }> }>>("engines:list", { key: KEY }))
    .some((item) => item.online && item.engines.some((engine) => engine.kind === "grok" && engine.signedIn)), "the runner with Grok signed in", 120);
  await call("dashboard:setDefaultAccess", { key: KEY, access: "full" });
  const chat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: chat, model: "grok-fake-fast", engine: "grok" });

  const browser = await p.openBrowser();
  const { evaluate, send } = browser;
  const shot = (name: string) => send("Page.captureScreenshot", { format: "png" }).then((image: { data: string }) => writeFileSync(join(outDir, name), Buffer.from(image.data, "base64")));
  const section = `document.querySelector('section[aria-label="GitHub"]')`;
  const sectionText = () => evaluate(`${section}?.innerText ?? ""`) as Promise<string>;
  const click = (scope: string, label: string) => evaluate(`(() => { const b = [...(${scope}?.querySelectorAll("button") ?? [])].find((b) => b.innerText.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
  const type = (value: string) => evaluate(`(() => {
    const el = ${section}.querySelector('input[aria-label="GitHub token"]'); if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const submit = () => evaluate(`(() => { const form = ${section}.querySelector('form[aria-label="GitHub token"]'); form.requestSubmit(); return true; })()`);
  const open = async () => {
    await send("Page.navigate", { url: `${BASE}/apps/connectors` });
    await until(async () => /Not connected|Connected as|token/.test(await sectionText()), "the GitHub section", 30);
  };

  // --- 11. On the page without Composio ----------------------------------------------------------
  await open();
  const first = await evaluate(`document.body.innerText`) as string;
  check("onThePageWithoutComposio", /Not connected/.test(await sectionText()) && /Connect with a token/.test(await sectionText()) && /Paste your Composio key/.test(first), (await sectionText()).slice(0, 200));

  // --- 1, 2. A wrong token ----------------------------------------------------------------------
  await click(section, "Connect with a token");
  await until(() => evaluate(`Boolean(${section}.querySelector('input[aria-label="GitHub token"]'))`), "the token field", 10);
  await type(WRONG);
  await submit();
  await until(() => evaluate(`Boolean(${section}.querySelector('[role="alert"]'))`), "the wrong token's error", 30);
  const wrongText = await sectionText();
  await shot("wrong-token.png");
  check("wrongTokenSaysRefused", /doesn't accept this token/.test(wrongText), wrongText.slice(0, 300));
  check("wrongTokenNotKept", kept().length === 0 && (await backend()).state === "none" && /Not connected/.test(wrongText) && !/Connected as/.test(wrongText));
  check("wrongTokenAskedGitHub", gitHub.requests.some((item) => item.path === "/user" && item.token === WRONG));

  // --- 3, 4. The right one ----------------------------------------------------------------------
  await type(GOOD);
  await submit();
  await until(async () => /Connected as/.test(await sectionText()), "connected as", 30);
  const rightText = await sectionText();
  const html = await evaluate(`document.documentElement.outerHTML`) as string;
  await shot("connected.png");
  const connected = await backend();
  check("rightTokenNamesTheAccount", /Connected as octo-owner \(Octo Owner\)/.test(rightText) && connected.state === "working" && connected.login === "octo-owner", rightText.slice(0, 200));
  check("rightTokenKept", kept().length === 1 && kept()[0].value === GOOD);
  check("tokenNotShownBack", !html.includes(GOOD) && !JSON.stringify(connected).includes(GOOD));

  // --- 6, 7. The agent: list, find, read, and a change held after the read --------------------------
  const agent = await turn(chat, tools([
    ["list_connectors", {}],
    ["find_action", { query: "list my GitHub repositories" }],
    ["run_action", { slug: "GITHUB_REST_GET", args: { path: "/user/repos", query: { per_page: 1 } } }],
    ["run_action", { slug: "GITHUB_REST_CHANGE", args: { method: "POST", path: "/repos/octo-owner/perry-notes/issues", body: { title: "Asked by a page" } } }],
  ]));
  notes.agentTurn = agent.map((item) => ({ tool: item.tool, answer: JSON.stringify(item.answer).slice(0, 400) }));
  const [listed, found, read, held] = agent.map((item) => item.answer);
  const github = (listed?.connectors ?? []).find((item: { slug: string }) => item.slug === "github");
  check("agentListsGitHub", github?.connected === true && github.account === "octo-owner", github);
  check("agentFindsGitHubActions", ["GITHUB_REST_GET", "GITHUB_REST_CHANGE"].every((slug) => (found?.actions ?? []).some((action: { slug: string }) => action.slug === slug)));
  const readResult = read?.result ?? read;
  check("agentReadsGitHub", readResult?.ok === true && readResult.data?.[0]?.full_name === "octo-owner/perry-notes" && readResult.next === "/user/repos?per_page=1&page=2"
    && gitHub.requests.some((item) => item.path === "/user/repos?per_page=1" && item.token === GOOD), readResult);
  check("changeHeldAfterRead", held?.refused === true && gitHub.issues.length === 0, held);

  const nextPage = await turn(chat, `TOOL run_action ${JSON.stringify({ slug: "GITHUB_REST_GET", args: { path: readResult?.next ?? "" } })}`);
  const second = nextPage[0]?.answer?.result ?? nextPage[0]?.answer;
  check("agentFollowsNextPage", second?.ok === true && second.data?.[0]?.full_name === "octo-owner/dotfiles", second);

  const owners = await turn(chat, `TOOL run_action ${JSON.stringify({ slug: "GITHUB_REST_CHANGE", args: { method: "POST", path: "/repos/octo-owner/perry-notes/issues", body: { title: "Asked by the owner" } } })}`);
  const opened = owners[0]?.answer?.result ?? owners[0]?.answer;
  check("changeGoesAheadOnItsOwn", opened?.ok === true && opened.data?.number === 7 && gitHub.issues.map((issue) => issue.title).join() === "Asked by the owner", opened);

  // --- 8. Another host ---------------------------------------------------------------------------
  const before = gitHub.requests.length;
  const away = await turn(chat, `TOOL run_action ${JSON.stringify({ slug: "GITHUB_REST_GET", args: { path: "https://evil.example/user" } })}`);
  const awayResult = away[0]?.answer?.result ?? away[0]?.answer;
  check("otherHostRefused", awayResult?.ok === false && /endpoint of GitHub's API/.test(awayResult.error ?? "") && gitHub.requests.length === before, awayResult);

  // --- 4. The token in the chat and the tool answers -------------------------------------------------
  const transcript = JSON.stringify(await messagesOf(chat));
  check("tokenNotInChatOrAnswers", !transcript.includes(GOOD) && !JSON.stringify(toolCalls().map((entry) => entry.answer)).includes(GOOD));

  // --- 5. Revoked at GitHub --------------------------------------------------------------------
  gitHub.valid.delete(GOOD);
  await open();
  await until(async () => /doesn't accept this token/.test(await sectionText()), "the revoked token's warning", 30);
  const revokedText = await sectionText();
  await shot("revoked.png");
  check("revokedShownOnPage", !/Connected as/.test(revokedText) && /Replace token/.test(revokedText) && /Disconnect/.test(revokedText), revokedText.slice(0, 300));
  const afterRevoke = await turn(chat, tools([["list_connectors", {}], ["run_action", { slug: "GITHUB_REST_GET", args: { path: "/user" } }]]));
  const revokedListed = (afterRevoke[0]?.answer?.connectors ?? []).find((item: { slug: string }) => item.slug === "github");
  const revokedRun = afterRevoke[1]?.answer?.result ?? afterRevoke[1]?.answer;
  check("revokedNotConnectedForAgent", revokedListed?.connected === false && revokedListed.status === "EXPIRED", revokedListed);
  check("revokedRunSaysReplace", revokedRun?.ok === false && /401/.test(revokedRun.error ?? "") && /replace it/.test(revokedRun.error ?? ""), revokedRun);

  // A wrong token does not replace the kept one; a new one does.
  await click(section, "Replace token");
  await until(() => evaluate(`Boolean(${section}.querySelector('input[aria-label="GitHub token"]'))`), "the token field again", 10);
  await type(WRONG);
  await submit();
  await until(() => evaluate(`Boolean(${section}.querySelector('[role="alert"]'))`), "the error on replacing", 30);
  check("wrongReplacementKeepsTheOld", kept().length === 1 && kept()[0].value === GOOD);
  await type(NEW);
  await submit();
  await until(async () => /Connected as/.test(await sectionText()), "connected again", 30);
  check("replacedAndWorking", kept().length === 1 && kept()[0].value === NEW && (await backend()).state === "working");

  // --- 9. Composio's GitHub, retired ---------------------------------------------------------------
  const viaComposio = await call<{ error?: string; redirectUrl?: string }>("dashboard:connectToolkit", { key: KEY, toolkit: "github", callbackUrl: `${BASE}/apps/connectors` });
  const triggers = await call<{ error?: string }>("composio:triggerTypes", { toolkit: "github" });
  check("composioGitHubRetired", !viaComposio.redirectUrl && /token/.test(viaComposio.error ?? "") && /token/.test(triggers.error ?? ""), { viaComposio, triggers });

  // --- 10. Disconnect, after asking ----------------------------------------------------------------
  const dialog = `document.querySelector('[role="alertdialog"], [role="dialog"]')`;
  await click(section, "Disconnect");
  await until(() => evaluate(`Boolean(${dialog})`), "the disconnect question", 10);
  await click(dialog, "Keep it");
  await sleep(1_000);
  check("disconnectAsksFirst", kept().length === 1 && (await backend()).state === "working");
  await click(section, "Disconnect");
  await until(() => evaluate(`Boolean(${dialog})`), "the disconnect question again", 10);
  await click(dialog, "Disconnect");
  await until(async () => /Not connected/.test(await sectionText()), "disconnected", 30);
  check("disconnectForgetsToken", kept().length === 0 && (await backend()).state === "none");

  // --- 12. --------------------------------------------------------------------------------------
  check("noPageErrors", browser.errors.length === 0, browser.errors.slice(0, 5));
  ok = true;
} catch (error) {
  check("ranToTheEnd", false, error instanceof Error ? error.stack : String(error));
} finally {
  notes.gitHubRequests = gitHub.requests.map((item) => ({ method: item.method, path: item.path, token: item.token === GOOD ? "the first" : item.token === NEW ? "the new one" : item.token === WRONG ? "the wrong one" : item.token ? "another" : "none" }));
  if (ok) check("ranToTheEnd", true);
  const passed = await p.finish();
  stub.close();
  process.exit(passed ? 0 : 1);
}
