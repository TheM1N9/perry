import { backend } from "@/server/index";

/**
 * A stored file, by its id; the id is the capability, as Convex's storage URLs were. Byte ranges are served too,
 * so a voice note or video from Telegram or WhatsApp can be sought in (components/ui/media-player.tsx).
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const blob = await backend().readFile(id).catch(() => null);
  if (!blob) return new Response("Not found", { status: 404 });
  const headers = new Headers({ "content-type": blob.type || "application/octet-stream", "cache-control": "private, max-age=31536000, immutable", "accept-ranges": "bytes" });
  const range = request.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && blob.size > 0) {
    const start = range[1] ? Number(range[1]) : Math.max(0, blob.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), blob.size - 1) : blob.size - 1;
    if (start > end || start >= blob.size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${blob.size}` } });
    headers.set("content-range", `bytes ${start}-${end}/${blob.size}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(blob.slice(start, end + 1), { status: 206, headers });
  }
  headers.set("content-length", String(blob.size));
  return new Response(blob, { headers });
}
