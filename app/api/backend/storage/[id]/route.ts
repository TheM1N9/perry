import { backend } from "@/server/index";

/** A stored file, by its id; the id is the capability, as Convex's storage URLs were. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const blob = await backend().readFile(id).catch(() => null);
  if (!blob) return new Response("Not found", { status: 404 });
  return new Response(blob, {
    headers: { "content-type": blob.type || "application/octet-stream", "content-length": String(blob.size), "cache-control": "private, max-age=31536000, immutable" },
  });
}
