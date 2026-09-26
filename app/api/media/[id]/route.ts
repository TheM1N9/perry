import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { dashboardKey, query } from "../store";

/**
 * Serve a local chat file from wherever it lives. Only attachments a chat
 * references are served, only to the dashboard key's holder, and only media
 * types render inline: anything else downloads, so a stored HTML or SVG file
 * cannot run on this origin. Byte ranges are supported so videos can seek.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const path = attachment.localPath;
  const size = await stat(path).then((info) => (info.isFile() ? info.size : null), () => null);
  if (size === null) return new Response("This file is no longer where it was saved on this computer.", { status: 404 });

  const inline = /^(image|video|audio)\//.test(attachment.contentType) && attachment.contentType !== "image/svg+xml";
  const headers = new Headers({
    "Content-Type": inline ? attachment.contentType : "application/octet-stream",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=3600",
    "Accept-Ranges": "bytes",
  });

  const range = request.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && size > 0) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    headers.set("Content-Length", String(end - start + 1));
    return new Response(Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream, { status: 206, headers });
  }
  headers.set("Content-Length", String(size));
  return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { headers });
}
