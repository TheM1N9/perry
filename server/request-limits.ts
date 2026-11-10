export class RequestLimitError extends Error {
  constructor(message: string, readonly status: 400 | 408 | 413 = 413) { super(message); }
}

// Fixed-size admission state; no address/token map can grow in a long-lived server.
const budgets = {
  call: { active: 0, window: 0, count: 0, concurrent: 16, perMinute: 3000 },
  upload: { active: 0, window: 0, count: 0, concurrent: 2, perMinute: 30 },
};

/** Hold admission until the entire handler finishes, not just until its body is buffered. */
export function requestSlot(kind: keyof typeof budgets): (() => void) | null {
  const state = budgets[kind];
  const now = Date.now();
  if (now < state.window || now - state.window >= 60_000) { state.window = now; state.count = 0; }
  if (state.active >= state.concurrent || state.count >= state.perMinute) return null;
  state.active++; state.count++;
  let released = false;
  return () => { if (!released) { released = true; state.active--; } };
}

export const busyResponse = () => Response.json({ error: "Perry is handling too many requests. Try again shortly." }, { status: 429, headers: { "Retry-After": "5" } });

/** Bearer authentication still applies; browser cross-origin writes are refused as defense in depth. */
export function requestOriginAllowed(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const supplied = new URL(origin);
    // Next constructs request.url with its internal listening hostname. Host
    // retains the authority the browser actually reached (including its port).
    const host = request.headers.get("host") ?? new URL(request.url).host;
    return ["http:", "https:"].includes(supplied.protocol) && supplied.host === host;
  } catch { return false; }
}

/** Enforce size while streaming, even when Content-Length is missing or inaccurate. */
export async function requestBytes(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  request.signal.throwIfAborted();
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isFinite(declared) || declared < 0) throw new RequestLimitError("Invalid Content-Length.", 400);
  if (declared > maxBytes) throw new RequestLimitError("This request is too large.");
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  let failure: unknown;
  const stop = (reason: unknown) => {
    if (failure !== undefined) return;
    failure = reason;
    void reader.cancel(reason).catch(() => {});
  };
  const abort = () => stop(request.signal.reason);
  // JSON keeps its 30s cap; large uploads allow roughly 2 Mbit/s plus startup.
  const deadline = 30_000 + Math.ceil(Math.max(0, maxBytes - 2 * 1024 * 1024) / (256 * 1024)) * 1000;
  const timer = setTimeout(() => stop(new RequestLimitError("Reading the request timed out.", 408)), deadline);
  request.signal.addEventListener("abort", abort, { once: true });
  let buffer = new Uint8Array(Math.min(maxBytes, Math.max(1024, declared)));
  let size = 0;
  let ended = false;
  try {
    if (request.signal.aborted) abort();
    while (true) {
      if (failure !== undefined) throw failure;
      const { value, done } = await reader.read();
      if (failure !== undefined) throw failure;
      if (done) { ended = true; return buffer.subarray(0, size); }
      if (size + value.byteLength > maxBytes) throw new RequestLimitError("This request is too large.");
      if (size + value.byteLength > buffer.byteLength) {
        const grown = new Uint8Array(Math.min(maxBytes, Math.max(size + value.byteLength, buffer.byteLength * 2)));
        grown.set(buffer); buffer = grown;
      }
      buffer.set(value, size); size += value.byteLength;
    }
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    if (!ended) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
