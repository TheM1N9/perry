import type { NextRequest } from "next/server";
import { dashboardKey, query, serveFile } from "../../store";

async function serve(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const key = dashboardKey(request);
  if (!key) return new Response("Unlock the dashboard first.", { status: 401 });
  const { id } = await params;
  const conversationId = request.nextUrl.searchParams.get("conversation");
  const scope = request.nextUrl.searchParams.get("scope");
  if (!conversationId || (scope !== "chat" && scope !== "project")) return new Response("Choose a workspace.", { status: 400 });
  try {
    const item = await query<{ path: string; name: string; contentType: string } | null>("workspace:file", { key, id, conversationId, scope });
    if (!item) return new Response("Not found in this workspace.", { status: 404 });
    const response = await serveFile(request, { path: item.path, fileName: item.name, contentType: item.contentType }, { preview: true });
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Content-Security-Policy", "sandbox; default-src 'none'; media-src 'self'; style-src 'unsafe-inline'");
    return response;
  } catch {
    return new Response("Workspace unavailable.", { status: 403 });
  }
}
export const GET = serve;
export const HEAD = serve;
