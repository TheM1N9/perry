import type { NextRequest } from "next/server";
import { dashboardKey, query, serveFile } from "../store";

/**
 * Serve a chat file from local uploads or storage. Only attachments a chat
 * references are served, only to the dashboard key's holder, and only media
 * types render inline (store.ts, serveFile).
 */
async function serve(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const key = dashboardKey(request);
  if (!key) return new Response("Unlock the dashboard first.", { status: 401 });

  let attachment: { localPath: string; fileName: string; contentType: string } | null;
  try {
    attachment = await query("media:localAttachment", { key, id });
  } catch {
    return new Response("Wrong dashboard key.", { status: 403 });
  }
  if (!attachment) return new Response("Not found", { status: 404 });
  return await serveFile(request, { path: attachment.localPath, fileName: attachment.fileName, contentType: attachment.contentType }, { preview: request.nextUrl.searchParams.has("preview") });
}

export const GET = serve;
export const HEAD = serve;
