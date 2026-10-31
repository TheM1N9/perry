import { z } from "zod";
import { authorizeBrowser, browserFailure } from "@/server/browser-api";
import { streamBrowser } from "@/server/browser-stream";

/** The live view of a chat's browser, as it changes (server/browser-stream.ts). Same owner-only checks as /api/browser. */
export async function POST(request: Request, peerAddress?: string) {
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 1_000) return Response.json({ error: "Browser request is too large." }, { status: 413 });
    const input = z.object({ conversationId: z.string().min(1).max(150), width: z.number().int().min(320).max(4096) }).parse(await request.json());
    const { importEnabled } = await authorizeBrowser(request, input.conversationId, peerAddress);
    return new Response(streamBrowser(input.conversationId, importEnabled, input.width, request.signal), {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff", "X-Accel-Buffering": "no" },
    });
  } catch (error) { return browserFailure(error); }
}
