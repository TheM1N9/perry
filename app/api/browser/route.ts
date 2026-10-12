import { z } from "zod";
import { browserRequest } from "@/lib/browser-protocol";
import { authorizeBrowser, browserFailure } from "@/server/browser-api";
import { controlBrowser } from "@/server/browser-host";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 32_000) return Response.json({ error: "Browser request is too large." }, { status: 413 });
    const input = z.object({ conversationId: z.string().min(1).max(150), request: browserRequest }).parse(await request.json());
    const { importEnabled } = await authorizeBrowser(request, input.conversationId);
    const result = await controlBrowser(input.conversationId, input.request, importEnabled);
    return Response.json(result, { headers: { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return browserFailure(error); }
}
