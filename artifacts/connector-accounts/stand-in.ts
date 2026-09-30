import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * A stand-in Composio for artifacts/connector-accounts/run.ts --stand-in: the
 * slice of its REST API the Connectors page reaches through @composio/core,
 * which reads COMPOSIO_BASE_URL, so Perry's own code runs unchanged against
 * it. It holds connections the owner's real account may not have on the day:
 * one address signed in twice, an expired sign-in next to a working one, a
 * sign-in never finished, two connections with no address. Every address is
 * made up. Anything it is not built for answers 404 and is noted, so a new
 * call the page starts making shows in the result instead of passing quietly.
 */

export type Connection = { id: string; toolkit: string; status: string; createdAt: string; identity?: string };

const APPS: Record<string, { name: string; color: string; description: string; category: string }> = {
  gmail: { name: "Gmail", color: "#ea4335", description: "Email by Google.", category: "Email" },
  googlecalendar: { name: "Google Calendar", color: "#4285f4", description: "Calendars and events by Google.", category: "Scheduling" },
  slack: { name: "Slack", color: "#611f69", description: "Team chat.", category: "Communication" },
  notion: { name: "Notion", color: "#111111", description: "Notes and docs.", category: "Productivity" },
  youtube: { name: "YouTube", color: "#ff0000", description: "Videos.", category: "Entertainment" },
  higgsfield_mcp: { name: "Higgsfield MCP", color: "#7c3aed", description: "Image and video generation.", category: "AI" },
  googledrive: { name: "Google Drive", color: "#0f9d58", description: "Files by Google.", category: "Storage" },
  github: { name: "GitHub", color: "#24292f", description: "Code hosting.", category: "Developer tools" },
};

/** The "who am I" actions Perry asks (convex/composio.ts WHO_AM_I), answered per connection. */
const WHO_AM_I: Record<string, (identity: string) => unknown> = {
  GMAIL_GET_PROFILE: (identity) => ({ emailAddress: identity, messagesTotal: 12 }),
  GOOGLECALENDAR_GET_CALENDAR_PROFILE: (identity) => ({ calendar: { id: identity, summary: identity } }),
  SLACK_TEST_AUTH: (identity) => ({ ok: true, user: identity, team: "Stand-in team" }),
};

const at = (day: string) => `2026-09-${day}Z`;

/** What the owner has connected, before the run changes anything. */
export const CONNECTIONS: Connection[] = [
  // One address signed in to twice: one account, one spare.
  { id: "ca_gmail_alex_1", toolkit: "gmail", status: "ACTIVE", createdAt: at("12T09:00:00"), identity: "alex@example.com" },
  { id: "ca_gmail_alex_2", toolkit: "gmail", status: "ACTIVE", createdAt: at("20T09:00:00"), identity: "alex@example.com" },
  // A second Gmail, which expires once its address is known.
  { id: "ca_gmail_sam", toolkit: "gmail", status: "ACTIVE", createdAt: at("14T09:00:00"), identity: "sam@example.com" },
  // Reconnected: the old sign-in expires after the new one works, both the same address.
  { id: "ca_cal_old", toolkit: "googlecalendar", status: "ACTIVE", createdAt: at("02T09:00:00"), identity: "alex@example.com" },
  { id: "ca_cal_new", toolkit: "googlecalendar", status: "ACTIVE", createdAt: at("22T09:00:00"), identity: "alex@example.com" },
  { id: "ca_slack", toolkit: "slack", status: "ACTIVE", createdAt: at("05T09:00:00"), identity: "alex" },
  // Expired before Perry ever asked who it was, so no address.
  { id: "ca_youtube", toolkit: "youtube", status: "EXPIRED", createdAt: at("03T09:00:00") },
  // A sign-in started and never finished.
  { id: "ca_notion", toolkit: "notion", status: "INITIATED", createdAt: at("25T09:00:00") },
  // Two with no "who am I": nothing says whether they are the same account.
  { id: "ca_hf_1", toolkit: "higgsfield_mcp", status: "ACTIVE", createdAt: at("24T08:15:00") },
  { id: "ca_hf_2", toolkit: "higgsfield_mcp", status: "ACTIVE", createdAt: at("24T17:40:00") },
];

export async function startStandIn() {
  const connections = CONNECTIONS.map((item) => ({ ...item }));
  const deleted: string[] = [];
  const links: Array<{ toolkit: string; callbackUrl?: string }> = [];
  const unknown: string[] = [];
  let base = "";

  const logo = (slug: string) => `${base}/logo/${slug}.svg`;
  const account = (item: Connection) => ({
    id: item.id, status: item.status, status_reason: null, is_disabled: false, created_at: item.createdAt, updated_at: item.createdAt,
    toolkit: { slug: item.toolkit }, auth_config: { id: `ac_${item.toolkit}`, auth_scheme: "OAUTH2", is_composio_managed: true, is_disabled: false },
    user_id: "owner", data: {}, test_request_endpoint: "",
  });
  const toolkit = (slug: string) => {
    const app = APPS[slug];
    return {
      slug, name: app.name, is_local_toolkit: false, auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: ["OAUTH2"], no_auth: false,
      meta: { logo: logo(slug), description: `${app.description} A stand-in.`, categories: [{ id: app.category.toLowerCase(), name: app.category }], created_at: at("01T00:00:00"), updated_at: at("01T00:00:00"), tools_count: 10, triggers_count: 0 },
    };
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const read = (req: IncomingMessage) => new Promise<any>((done) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { try { done(body ? JSON.parse(body) : {}); } catch { done({}); } });
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stand-in");
    const path = url.pathname.replace(/^\/api\/v3(\.1)?/, "");
    const body = req.method === "GET" || req.method === "DELETE" ? {} : await read(req);
    let match: RegExpMatchArray | null;

    if (req.method === "GET" && (match = url.pathname.match(/^\/logo\/(\w+)\.svg$/))) {
      const app = APPS[match[1]];
      res.writeHead(app ? 200 : 404, { "content-type": "image/svg+xml" });
      return res.end(app ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22"><rect width="22" height="22" rx="6" fill="${app.color}"/><text x="11" y="15.5" font-family="Arial" font-size="12" font-weight="700" fill="#fff" text-anchor="middle">${app.name[0]}</text></svg>` : "");
    }
    // Where "Add another account" and Reconnect land: the provider's sign-in page, in real life.
    if (req.method === "GET" && url.pathname === "/link") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<!doctype html><title>Stand-in sign-in</title><h1>Stand-in sign-in for ${url.searchParams.get("toolkit")}</h1>`);
    }
    if (req.method === "GET" && path === "/connected_accounts") {
      const users = url.searchParams.getAll("user_ids").flatMap((value) => value.split(","));
      const items = connections.filter(() => users.length === 0 || users.includes("owner")).map(account);
      return json(res, 200, { items, next_cursor: null, total_pages: 1, current_page: 1 });
    }
    if (req.method === "DELETE" && (match = path.match(/^\/connected_accounts\/([\w-]+)$/))) {
      const index = connections.findIndex((item) => item.id === match![1]);
      if (index < 0) return json(res, 404, { error: { message: "Connected account not found" } });
      connections.splice(index, 1);
      deleted.push(match[1]);
      return json(res, 200, { success: true });
    }
    if (req.method === "GET" && path === "/toolkits") {
      return json(res, 200, { items: Object.keys(APPS).map(toolkit), next_cursor: null, total_pages: 1, current_page: 1 });
    }
    if (req.method === "GET" && (match = path.match(/^\/tools\/(\w+)$/))) {
      const slug = match[1];
      if (!WHO_AM_I[slug]) return json(res, 404, { error: { message: `No tool ${slug}` } });
      return json(res, 200, {
        slug, name: slug, description: "Who the connection is signed in as.", toolkit: { slug: slug.split("_")[0].toLowerCase(), name: slug, logo: "" },
        input_parameters: { type: "object", properties: {} }, output_parameters: { type: "object", properties: {} }, version: "20260901_00", available_versions: ["20260901_00"], tags: [], no_auth: false, is_deprecated: false,
      });
    }
    if (req.method === "POST" && (match = path.match(/^\/tools\/execute\/(\w+)$/))) {
      const item = connections.find((entry) => entry.id === body.connected_account_id);
      const answer = WHO_AM_I[match[1]];
      if (!item || !answer || item.status !== "ACTIVE" || !item.identity) return json(res, 200, { data: {}, error: "Not available", successful: false, log_id: "log_stand_in" });
      return json(res, 200, { data: answer(item.identity), error: null, successful: true, log_id: "log_stand_in" });
    }
    if (req.method === "POST" && path === "/tool_router/session") {
      return json(res, 200, { session_id: "trs_stand_in", mcp: { type: "http", url: `${base}/mcp` }, tool_router_tools: [], config: { user_id: "owner", manage_connections: { enable: true } }, config_version: 1 });
    }
    if (req.method === "POST" && (match = path.match(/^\/tool_router\/session\/[\w-]+\/link$/))) {
      links.push({ toolkit: body.toolkit, callbackUrl: body.callback_url });
      return json(res, 200, { connected_account_id: `ca_new_${links.length}`, redirect_url: `${base}/link?toolkit=${encodeURIComponent(body.toolkit)}`, link_token: "lt_stand_in" });
    }
    // The browser asks the sign-in page for an icon; Composio isn't asked for anything else unplanned.
    if (url.pathname !== "/favicon.ico") unknown.push(`${req.method} ${url.pathname}`);
    return json(res, 404, { error: { message: `The stand-in has no ${req.method} ${url.pathname}` } });
  });
  const port = await new Promise<number>((done) => server.listen(0, "127.0.0.1", () => done((server.address() as { port: number }).port)));
  base = `http://127.0.0.1:${port}`;
  return {
    url: base,
    connections, deleted, links, unknown,
    /** Change a connection's state at "Composio", as time would. */
    set: (id: string, status: string) => { connections.find((item) => item.id === id)!.status = status; },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
