import type { NextRequest } from "next/server";
import { backend } from "@/server/index";

/** Upload a file to an address from generateUploadUrl; answers `{ storageId }`, as Convex's upload URLs did. */
export async function POST(request: NextRequest) {
  const ticket = request.nextUrl.searchParams.get("ticket") ?? "";
  const blob = new Blob([await request.arrayBuffer()], { type: request.headers.get("content-type") ?? "" });
  const storageId = await backend().acceptUpload(ticket, blob);
  if (!storageId) return Response.json({ error: "This upload address has expired or was already used." }, { status: 403 });
  return Response.json({ storageId });
}
