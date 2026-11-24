import type { NextRequest } from "next/server";
import { backend } from "@/server/index";
import { serveFile } from "@/app/api/media/store";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = request.headers.get("authorization")?.replace(/^Bearer /i, "");
  if (!token) return new Response("Runner authentication required.", { status: 401 });
  try {
    const { id } = await params;
    const { value } = await backend().runQuery("media:runnerAttachment", { token, id });
    const file = value as { localPath: string; fileName: string; contentType: string } | null;
    if (!file) return new Response("File unavailable to this computer.", { status: 404 });
    return await serveFile(request, { path: file.localPath, fileName: file.fileName, contentType: file.contentType });
  } catch { return new Response("Runner authentication failed.", { status: 403 }); }
}
