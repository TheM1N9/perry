import { backend } from "@/server/index";
import { requestOriginAllowed } from "@/server/request-limits";

/**
 * Server-sent events: which tables each committed change wrote, so the
 * dashboard and the runner re-run the queries that read them. Carries table
 * names only, never data.
 */
export async function GET(request: Request) {
  if (!requestOriginAllowed(request)) return new Response("Foreign browser origin.", { status: 403 });
  if (request.signal.aborted) return new Response(null, { status: 499 });
  const runtime = backend();
  const limit = 32;
  if (runtime.events.listenerCount("change") >= limit) {
    return new Response("Too many open change streams.", { status: 429, headers: { "Retry-After": "5" } });
  }
  // The same native listener count enforces the hard limit above.
  runtime.events.setMaxListeners(Math.max(runtime.events.getMaxListeners(), limit));
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (text: string) => {
        const bytes = encoder.encode(text);
        if (controller.desiredSize !== null && bytes.byteLength > controller.desiredSize) { abort(); return; }
        try { controller.enqueue(bytes); } catch { cleanup(); }
      };
      const onChange = (tables: string[]) => send(`data: ${JSON.stringify({ tables })}\n\n`);
      const abort = () => { cleanup(); try { controller.close(); } catch {} };
      runtime.events.on("change", onChange);
      // A comment every 15 seconds keeps proxies and the browser from closing an idle stream.
      const keepAlive = setInterval(() => send(": keep-alive\n\n"), 15_000);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        runtime.events.off("change", onChange);
        request.signal.removeEventListener("abort", abort);
      };
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) { abort(); return; }
      send("retry: 2000\n\n");
    },
    cancel() { cleanup(); },
  }, { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
  });
}
