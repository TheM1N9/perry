import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import type { FoundAction } from "./composio";

/**
 * GitHub, connected with a token the owner makes on GitHub (a fine-grained or
 * classic personal access token) instead of through Composio, whose OAuth app
 * an organization has to approve first. The token's own access is all Perry
 * gets. Perry keeps it with its keys (secrets.ts), never sends it back to a
 * browser, and reaches GitHub's REST API with it through the same three tools
 * as every other app: list_connectors, find_action and run_action.
 *
 * A token is kept only once GitHub has said whose it is, and GitHub is asked
 * again whenever the connection is shown or listed, so a wrong, expired or
 * revoked token never reads as connected.
 */

const TOKEN = "PERRY_GITHUB_TOKEN";
/** GitHub's API; GITHUB_API_BASE points Perry at another (GitHub Enterprise's /api/v3, or the stand-in in artifacts/github-token). */
const apiBase = () => `${(process.env.GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/, "")}/`;

export const GET = "GITHUB_REST_GET";
export const CHANGE = "GITHUB_REST_CHANGE";

export type GitHubConnection =
  | { state: "none" }
  | { state: "working"; login: string; name?: string }
  /** GitHub refused the token: wrong, expired or revoked. */
  | { state: "refused"; error: string }
  /** GitHub could not be asked; the token may be fine. */
  | { state: "unreachable"; error: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function request(token: string, method: string, url: URL, body?: unknown, accept?: string) {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: accept ?? "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "Perry",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { status: response.status, data, text, link: response.headers.get("link") };
}

const said = (data: unknown, text: string) =>
  (data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string" ? (data as { message: string }).message : text).slice(0, 300).replace(/\.$/, "");

/** Whose token it is, by asking GitHub. */
async function whoIs(token: string): Promise<Exclude<GitHubConnection, { state: "none" }>> {
  let answer: Awaited<ReturnType<typeof request>>;
  try {
    answer = await request(token, "GET", new URL("user", apiBase()));
  } catch (error) {
    return { state: "unreachable", error: `Couldn't reach GitHub: ${message(error)}` };
  }
  const user = answer.data as { login?: unknown; name?: unknown } | null;
  if (answer.status === 200 && typeof user?.login === "string") {
    return { state: "working", login: user.login, ...(typeof user.name === "string" && user.name ? { name: user.name } : {}) };
  }
  if (answer.status === 401) return { state: "refused", error: "GitHub doesn't accept this token: it's wrong, expired or revoked." };
  if (answer.status === 403) return { state: "refused", error: `GitHub refused this token: ${said(answer.data, answer.text)}` };
  return { state: "unreachable", error: `GitHub answered ${answer.status}: ${said(answer.data, answer.text)}` };
}

/** The connection as it is right now: GitHub is asked about the kept token every time. */
export const connection = internalAction({
  args: {},
  handler: async (ctx): Promise<GitHubConnection> => {
    const token: string | null = await ctx.runQuery(internal.secrets.get, { name: TOKEN });
    return token ? await whoIs(token) : { state: "none" };
  },
});

/** Keep a pasted token, only once GitHub has said whose it is; a refused one leaves the kept token as it was. */
export const connect = internalAction({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<{ login?: string; name?: string; error?: string }> => {
    const token = args.token.trim();
    if (!token) return { error: "Paste a token first." };
    const found = await whoIs(token);
    if (found.state !== "working") return { error: found.error };
    await ctx.runMutation(internal.secrets.keepToken, { name: TOKEN, value: token });
    return { login: found.login, ...(found.name ? { name: found.name } : {}) };
  },
});

/** Forget the token. It still works at GitHub until the owner deletes it there. */
export const disconnect = internalAction({
  args: {},
  handler: async (ctx): Promise<null> => {
    await ctx.runMutation(internal.secrets.keepToken, { name: TOKEN, value: "" });
    return null;
  },
});

const PATH = { type: "string", description: "The endpoint's path from docs.github.com/rest, placeholders filled in, e.g. /repos/OWNER/REPO/pulls/12. A `next` from an earlier answer goes here as it is." };
/** The two actions GitHub has: everything in its REST API, split by whether it reads or acts (mcp.ts tells them apart by name). */
const ACTIONS: FoundAction[] = [
  {
    slug: GET,
    toolkit: "github",
    description:
      "Read anything from GitHub's REST API with the owner's token: repositories, issues, pull requests with their reviews, files " +
      "and diffs, commits, branches, releases, Actions runs, notifications, gists, the owner's own profile (/user). Returns " +
      "GitHub's JSON, and `next` when there is another page. A 404 can mean the token cannot see it: a fine-grained token sees " +
      "only the repositories it was given.",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH,
        query: { type: "object", description: "Query parameters, e.g. { \"state\": \"open\", \"per_page\": 50 }.", additionalProperties: { type: ["string", "number", "boolean"] } },
        accept: { type: "string", description: "A media type GitHub offers, e.g. application/vnd.github.diff for a pull request's diff." },
      },
      required: ["path"],
    },
  },
  {
    slug: CHANGE,
    toolkit: "github",
    description:
      "Create, change or delete something on GitHub through its REST API: open or comment on an issue or pull request, review, " +
      "merge, label, close, star, start a workflow. It acts on the owner's real account, so get their go-ahead first.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["POST", "PATCH", "PUT", "DELETE"] },
        path: PATH,
        body: { type: "object", description: "The JSON the endpoint takes." },
      },
      required: ["method", "path"],
    },
  },
];

/** A request that is plausibly about GitHub; find_action names toolkits only sometimes. */
const ABOUT_GITHUB = /github|\brepo|pull request|\bprs?\b|\bissues?\b|\bcommits?\b|\bbranch|\bgists?\b|\breleases?\b|workflow|\bforks?\b/i;

/** GitHub's actions, when the request is about GitHub and a token is kept. Run checks the token. */
export const search = internalAction({
  args: { query: v.string(), toolkits: v.optional(v.array(v.string())) },
  handler: async (ctx, args): Promise<{ actions: FoundAction[]; notConnected?: string[] }> => {
    const named = args.toolkits?.some((toolkit) => toolkit.toLowerCase() === "github");
    if (args.toolkits?.length ? !named : !ABOUT_GITHUB.test(args.query)) return { actions: [] };
    const token: string | null = await ctx.runQuery(internal.secrets.get, { name: TOKEN });
    if (!token) return { actions: [], ...(named ? { notConnected: ["github: not connected; the owner adds a token in Apps & skills → Connectors."] } : {}) };
    return { actions: ACTIONS };
  },
});

/** The longest answer handed back whole; GitHub's lists can be large. */
const MAX_TEXT = 200_000;

/** Run GITHUB_REST_GET or GITHUB_REST_CHANGE with the kept token. */
export const execute = internalAction({
  args: { slug: v.string(), args: v.optional(v.any()) },
  handler: async (ctx, input): Promise<{ ok: boolean; data?: unknown; next?: string; error?: string }> => {
    if (input.slug !== GET && input.slug !== CHANGE) {
      return { ok: false, error: `GitHub has no action ${input.slug}. Its actions are ${GET} and ${CHANGE}; find_action describes them.` };
    }
    const args = (input.args ?? {}) as { path?: unknown; query?: unknown; accept?: unknown; method?: unknown; body?: unknown };
    const method = input.slug === GET ? "GET" : String(args.method ?? "").toUpperCase();
    if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method)) return { ok: false, error: `${CHANGE} takes method POST, PATCH, PUT or DELETE.` };
    if (typeof args.path !== "string" || !args.path.trim()) return { ok: false, error: "Give the endpoint's path, e.g. /repos/OWNER/REPO/issues." };

    // The token goes to GitHub's API and nowhere else: a path cannot name another host or climb out of the base.
    const base = new URL(apiBase());
    const url = new URL(args.path.trim().replace(/^\/+/, ""), base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return { ok: false, error: "The path must be an endpoint of GitHub's API, like /repos/OWNER/REPO." };
    if (args.query && typeof args.query === "object") {
      for (const [key, value] of Object.entries(args.query as Record<string, unknown>)) url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
    const accept = typeof args.accept === "string" && /^application\/vnd\.github[\w.+-]*$/.test(args.accept) ? args.accept : undefined;

    const token: string | null = await ctx.runQuery(internal.secrets.get, { name: TOKEN });
    if (!token) return { ok: false, error: "GitHub is not connected. The owner adds a token in Apps & skills → Connectors." };
    let answer: Awaited<ReturnType<typeof request>>;
    try {
      answer = await request(token, method, url, method === "GET" || args.body === undefined ? undefined : args.body, accept);
    } catch (error) {
      return { ok: false, error: `Couldn't reach GitHub: ${message(error)}` };
    }
    const next = answer.link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    const data = answer.text.length > MAX_TEXT ? `${answer.text.slice(0, MAX_TEXT)}\n[cut at ${MAX_TEXT} characters; ask for less, e.g. a smaller per_page]` : answer.data;
    if (answer.status < 300) return { ok: true, data, ...(next ? { next: next.startsWith(base.href) ? `/${next.slice(base.href.length)}` : next } : {}) };
    const hint = answer.status === 401 ? " The token no longer works; the owner can replace it in Apps & skills → Connectors."
      : answer.status === 404 ? " It does not exist, or the token cannot see it."
        : "";
    return { ok: false, error: `GitHub said ${answer.status}: ${said(answer.data, answer.text)}.${hint}`, data };
  },
});
