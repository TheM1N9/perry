import { httpAction } from "./_generated/server";
import { handle as mcp } from "./mcp";
import { httpRouter } from "convex/server";

/**
 * HTTP endpoints, served by Perry's server under /api/backend/http.
 *
 * Telegram is no longer one of them: the server polls Telegram for updates
 * (server/telegram.ts), so nothing here has to be reachable from the internet.
 */

const http = httpRouter();

/** Assistant's tools for Codex turns. See mcp.ts. */
http.route({ path: "/mcp", method: "POST", handler: mcp });

/** Cheap liveness check, used by perry doctor. */
http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(JSON.stringify({ ok: true, service: "perry" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }),
});

export default http;
