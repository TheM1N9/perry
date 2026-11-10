import type { NextRequest } from "next/server";
import { backend } from "@/server/index";
import { busyResponse, requestBytes, requestOriginAllowed, requestSlot, RequestLimitError } from "@/server/request-limits";

/** Upload a file to an address from generateUploadUrl; answers `{ storageId }`, as Convex's upload URLs did. */
export async function POST(request: NextRequest) {
  if (!requestOriginAllowed(request)) return Response.json({ error: "This request came from another website." }, { status: 403 });
  const ticket = request.nextUrl.searchParams.get("ticket") ?? "";
  const runtime = backend();
  if (!await runtime.uploadTicketValid(ticket)) return Response.json({ error: "This upload address has expired or was already used." }, { status: 403 });
  const release = requestSlot("upload");
  if (!release) return busyResponse();
  try {
    const blob = new Blob([await requestBytes(request, 50 * 1024 * 1024)], { type: request.headers.get("content-type") ?? "" });
    const storageId = await runtime.acceptUpload(ticket, blob);
    if (!storageId) return Response.json({ error: "This upload address has expired or was already used." }, { status: 403 });
    return Response.json({ storageId });
  } catch (error) {
    if (error instanceof RequestLimitError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  } finally { release(); }
}
