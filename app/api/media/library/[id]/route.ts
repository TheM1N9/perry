import type { NextRequest } from "next/server";
import { dashboardKey, query, serveFile } from "../../store";

/**
 * Serve a Library item (convex/library.ts) from wherever its file is: on this
 * computer, or in Perry's storage. Only items in the Library, only to the
 * dashboard key's holder; a PDF and plain text show inline for the item's
 * preview, ?download=1 always downloads.
 */
async function serve(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const key = dashboardKey(request);
  if (!key) return new Response("Unlock the dashboard first.", { status: 401 });

  let item: { path: string; name: string; contentType: string } | null;
  try {
    item = await query("library:file", { key, id });
  } catch {
    return new Response("Wrong dashboard key.", { status: 403 });
  }
  if (!item) return new Response("Not found", { status: 404 });
  return await serveFile(request, { path: item.path, fileName: item.name, contentType: item.contentType }, { preview: true });
}

export const GET = serve;
export const HEAD = serve;
