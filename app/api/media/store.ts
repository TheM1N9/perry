import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { ensureHome } from "@/runner/home";

/**
 * Local media: chat files that stay on this machine.
 *
 * Each attachment records where its file lives, usually somewhere in
 * Assistant's home (runner/home.ts), and this server serves it from there.
 * Files the owner attaches land in the home's uploads folder. The runner on
 * the same machine reads the same paths, so Codex opens attachments straight
 * from disk.
 */
export function uploadDir(): string {
  return ensureHome().uploads;
}
export const MAX_BYTES = 50 * 1024 * 1024;

/** Media requests carry the dashboard key in a path-scoped cookie, never in the URL. */
export const MEDIA_COOKIE = "perry_media";

export function dashboardKey(request: NextRequest): string | null {
  return request.cookies.get(MEDIA_COOKIE)?.value || null;
}

/** Call a public backend function, as the browser would, in this same process; a desktop pet elsewhere, with its own key, too (server/devices.ts). */
export async function query<T>(path: string, args: Record<string, unknown>): Promise<T> {
  const { backend } = await import("@/server/index");
  const { asPet } = await import("@/server/devices");
  return (await backend().runQuery(path, await asPet(path, args))).value as T;
}

/**
 * Send a file from this computer: only media types render inline (a PDF and
 * plain text too, with `preview`, for the Library's item view), anything else
 * downloads, so a stored HTML or SVG file cannot run on this origin. With
 * `download`, it always downloads. Byte ranges are supported so videos can seek.
 */
export async function serveFile(request: NextRequest, file: { path: string; fileName: string; contentType: string }, options: { preview?: boolean } = {}): Promise<Response> {
  const { path } = file;
  const size = await stat(/*turbopackIgnore: true*/ path).then((info) => (info.isFile() ? info.size : null), () => null);
  if (size === null) return new Response("This file is no longer where it was saved on this computer.", { status: 404 });

  const download = request.nextUrl.searchParams.has("download");
  const media = /^(image|video|audio)\//.test(file.contentType) && file.contentType !== "image/svg+xml";
  // Text is sent as plain text, whatever it is: it shows as words and cannot run.
  const text = options.preview && /^(text\/(plain|markdown|csv)|application\/json)$/.test(file.contentType);
  const inline = !download && (media || (options.preview && (file.contentType === "application/pdf" || text)));
  const headers = new Headers({
    "Content-Type": text && inline ? "text/plain; charset=utf-8" : inline ? file.contentType : "application/octet-stream",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
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
    return new Response(Readable.toWeb(createReadStream(/*turbopackIgnore: true*/ path, { start, end })) as ReadableStream, { status: 206, headers });
  }
  headers.set("Content-Length", String(size));
  if (request.method === "HEAD") return new Response(null, { headers });
  return new Response(size < 64 * 1024 ? await readFile(/*turbopackIgnore: true*/ path) : Readable.toWeb(createReadStream(/*turbopackIgnore: true*/ path)) as ReadableStream, { headers });
}
