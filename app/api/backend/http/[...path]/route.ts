import { backend } from "@/server/index";

/** The routes in convex/http.ts: Codex's MCP tools and the health check. */
async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return backend().runHttp(`/${path.join("/")}`, request);
}

export { handle as GET, handle as POST };
