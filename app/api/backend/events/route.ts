import { backend } from "@/server/index";

/**
 * Server-sent events: which tables each committed change wrote, so the
 * dashboard and the runner re-run the queries that read them. Carries table
 * names only, never data.
 */
export async function GET(request: Request) {
  const runtime = backend();
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => { try { controller.enqueue(encoder.encode(text)); } catch { cleanup(); } };
      const onChange = (tables: string[]) => send(`data: ${JSON.stringify({ tables })}\n\n`);
      runtime.events.on("change", onChange);
      // A comment every 15 seconds keeps proxies and the browser from closing an idle stream.
      const keepAlive = setInterval(() => send(": keep-alive\n\n"), 15_000);
      cleanup = () => {
        clearInterval(keepAlive);
        runtime.events.off("change", onChange);
      };
      request.signal.addEventListener("abort", () => { cleanup(); try { controller.close(); } catch {} });
      send("retry: 2000\n\n");
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
  });
}
