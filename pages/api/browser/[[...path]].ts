import type { NextApiRequest, NextApiResponse } from "next";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { POST as control } from "@/server/browser-routes/control";
import { POST as stream } from "@/server/browser-routes/stream";
import { POST as upload } from "@/server/browser-routes/upload";

export const config = { api: { bodyParser: false, responseLimit: false } };

/** Node API routes retain the socket peer; App Router's Request discards it. */
export default async function browser(request: NextApiRequest, response: NextApiResponse) {
  response.setHeader("Cache-Control", "no-store, private");
  if (request.method !== "POST") { response.setHeader("Allow", "POST"); response.status(405).end(); return; }
  const path = request.query.path;
  const handler = path === undefined ? control : Array.isArray(path) && path.length === 1 ? path[0] === "stream" ? stream : path[0] === "upload" ? upload : null : null;
  if (!handler) { response.status(404).end(); return; }
  const abort = new AbortController();
  const close = () => abort.abort();
  request.once("aborted", close);
  response.once("close", close);
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, item);
    }
    const protocol = "encrypted" in request.socket && request.socket.encrypted ? "https" : "http";
    const init: RequestInit & { duplex: "half" } = { method: "POST", headers, body: Readable.toWeb(request) as ReadableStream<Uint8Array>, duplex: "half", signal: abort.signal };
    const input = new Request(`${protocol}://${request.headers.host ?? "localhost"}${request.url}`, init);
    const reply = await handler(input, request.socket.remoteAddress);
    response.statusCode = reply.status;
    reply.headers.forEach((value, name) => response.setHeader(name, value));
    if (reply.body) await pipeline(Readable.fromWeb(reply.body as NodeReadableStream<Uint8Array>), response);
    else response.end();
  } catch {
    if (!response.headersSent && !response.destroyed) response.status(500).json({ error: "Browser operation failed. Refresh the view or sign in manually." });
    else response.destroy();
  } finally {
    abort.abort();
    request.off("aborted", close);
    response.off("close", close);
  }
}
