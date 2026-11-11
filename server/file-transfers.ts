import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { uploadFilesSchema, type UploadFilesInput, type TransferReceipt, type TransferResult } from "../lib/file-transfers";

type TransferRequest = { method: "PUT" | "HEAD"; headers?: Headers; body?: Readable; signal: AbortSignal };
type TransferResponse = { status: number; headers: Headers };
export type TransferTransport = (url: string, options: TransferRequest) => Promise<TransferResponse>;
type Dependencies = { stateDir: string; scope: string; signal?: AbortSignal; request?: TransferTransport; retryDelayMs?: number };
type CheckedFile = UploadFilesInput["files"][number] & { handle: FileHandle; sha256: string; md5: string; mtime: number; destination: string };
type SavedReceipt = { fingerprint: string; files: TransferReceipt[] };
const active = new Set<string>();
const RETRIES = 3;
const FILE_TIMEOUT_MS = 5 * 60_000;

export const sendTransfer: TransferTransport = async (url, options) => {
  return await new Promise<TransferResponse>((resolveResponse, reject) => {
    const request = (new URL(url).protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: options.method, headers: Object.fromEntries(options.headers ?? []), signal: options.signal,
    }, response => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      let bytes = 0;
      response.on("data", chunk => { bytes += chunk.length; if (bytes > 65536) response.destroy(new Error("Storage response exceeded its limit.")); });
      response.once("error", reject);
      response.once("end", () => resolveResponse({ status: response.statusCode ?? 0, headers }));
      response.resume();
    });
    request.once("error", reject);
    if (options.body) void pipeline(options.body, request, { signal: options.signal }).catch(reject);
    else request.end();
  });
};

class TransferError extends Error {
  constructor(readonly status: TransferResult["status"], message: string) { super(message); }
}

export async function uploadManifest(manifestPath: string, deps: Dependencies): Promise<TransferResult> {
  if (!isAbsolute(manifestPath) || manifestPath.startsWith("\\\\") || /[\x00-\x1f]/.test(manifestPath)) throw new Error("Use an absolute local upload manifest path.");
  let input: unknown;
  const handle = await open(manifestPath, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16 * 1024 ** 2) throw new Error("Upload manifest must be a regular JSON file of at most16MB.");
    const content = await handle.readFile("utf8");
    input = JSON.parse(content.replace(/^\uFEFF/, ""));
  } catch { throw new Error("The local upload manifest could not be read as bounded JSON."); }
  finally { await handle.close(); }
  return await uploadFiles(input, deps);
}

function destination(raw: string, key: string, takeId: string, verify = false): { identity: string; expires: number } {
  let url: URL;
  try { url = new URL(raw); } catch { throw new TransferError("failed", "Invalid storage URL."); }
  if (url.protocol !== "https:" || !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/i.test(url.hostname) || url.port || url.username || url.password || url.hash)
    throw new TransferError("failed", "Use a signed HTTPS Cloudflare R2 URL from Channel Desk.");
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { throw new TransferError("failed", "Invalid storage key encoding."); }
  const bucket = path.split("/")[1];
  if (!bucket || path !== `/${bucket}/${key}` || !key.startsWith(`content-farm/takes/${takeId}/`) || key.split("/").some(part => !part || part === "." || part === "..") || key.includes("\\"))
    throw new TransferError("failed", "The storage URL does not belong to this take and key.");
  const query = url.searchParams;
  for (const name of ["X-Amz-Algorithm", "X-Amz-Credential", "X-Amz-Date", "X-Amz-Expires", "X-Amz-Signature", "X-Amz-SignedHeaders"])
    if (query.getAll(name).length !== 1) throw new TransferError("failed", "The signed storage URL is incomplete or ambiguous.");
  if (query.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256" || !/^[a-f0-9]{64}$/i.test(query.get("X-Amz-Signature")!) || !query.get("X-Amz-Credential")?.endsWith("/s3/aws4_request"))
    throw new TransferError("failed", "The storage URL is not an AWS4 signed request.");
  const signed = query.get("X-Amz-SignedHeaders")!.split(";");
  if (!signed.includes("host") || (!verify && (!signed.includes("content-length") || !signed.includes("if-none-match"))))
    throw new TransferError("failed", "The PUT reservation must bind the file size and prevent overwrites.");
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(query.get("X-Amz-Date")!);
  const seconds = Number(query.get("X-Amz-Expires"));
  const time = match ? Date.UTC(...([Number(match[1]), Number(match[2]) - 1, ...match.slice(3).map(Number)] as [number, number, number, number, number, number])) : NaN;
  if (!Number.isFinite(time) || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 604800 || time > Date.now() + 5 * 60_000)
    throw new TransferError("failed", "Invalid storage URL lifetime.");
  return { identity: `${url.origin}/${bucket}`, expires: time + seconds * 1000 };
}

function checkHeaders(file: UploadFilesInput["files"][number]) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(file.headers)) {
    const lower = key.toLowerCase();
    if (!["content-type", "if-none-match", "content-length"].includes(lower) || headers.has(key))
      throw new TransferError("failed", "Only the reservation's content type, size and conditional PUT headers are supported.");
    headers.set(key, value);
  }
  if (headers.get("content-type") !== file.type || headers.get("if-none-match") !== "*" || (headers.has("content-length") && headers.get("content-length") !== String(file.size)))
    throw new TransferError("failed", "Upload headers do not match the file manifest.");
  headers.set("content-length", String(file.size));
  return headers;
}

async function* chunks(handle: FileHandle, signal?: AbortSignal) {
  let position = 0;
  for (;;) {
    signal?.throwIfAborted();
    const buffer = Buffer.allocUnsafe(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) return;
    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

async function digest(handle: FileHandle, signal?: AbortSignal) {
  const sha = createHash("sha256"), md5 = createHash("md5");
  for await (const chunk of chunks(handle, signal)) { sha.update(chunk); md5.update(chunk); }
  return { sha256: sha.digest("hex"), md5: md5.digest("hex") };
}

function etag(response: TransferResponse) { return response.headers.get("etag")?.replace(/^"|"$/g, "").toLowerCase(); }
function receipt(file: CheckedFile, resumed: boolean): TransferReceipt {
  return { key: file.key, name: basename(file.path), size: file.size, sha256: file.sha256, etag: file.md5, resumed };
}
async function verify(file: CheckedFile, request: TransferTransport, signal: AbortSignal): Promise<boolean> {
  if (!file.verificationUrl) return false;
  if (destination(file.verificationUrl, file.key, file.key.split("/")[2], true).expires <= Date.now() + 1000)
    throw new TransferError("needs_fresh_urls", "Refresh create_upload using the same reservation request ID, then retry this batch.");
  let response: TransferResponse;
  try { response = await request(file.verificationUrl, { method: "HEAD", signal }); }
  catch { signal.throwIfAborted(); return false; }
  if (response.status === 404) return false;
  if ([401, 403].includes(response.status)) throw new TransferError("needs_fresh_urls", "Storage refused the verification signature; refresh the same reservation.");
  if (response.status < 200 || response.status >= 300) throw new TransferError("failed", `Storage verification returned HTTP ${response.status}.`);
  if (Number(response.headers.get("content-length")) !== file.size || etag(response) !== file.md5)
    throw new TransferError("failed", "An existing object does not match this file. Do not finalize or overwrite it.");
  return true;
}

async function unchanged(file: CheckedFile) {
  const now = await file.handle.stat();
  if (now.size !== file.size || now.mtimeMs !== file.mtime)
    throw new TransferError("failed", "A local file changed during its upload. Keep the existing take and inspect the reservation before finalizing.");
}

async function transfer(file: CheckedFile, deps: Dependencies): Promise<void> {
  const request = deps.request ?? sendTransfer;
  const signal = deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(FILE_TIMEOUT_MS)]) : AbortSignal.timeout(FILE_TIMEOUT_MS);
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    signal.throwIfAborted();
    if (destination(file.url, file.key, file.key.split("/")[2]).expires <= Date.now() + 1000)
      throw new TransferError("needs_fresh_urls", "Refresh create_upload using the same reservation request ID, then retry this batch.");
    await unchanged(file);
    const stream = Readable.from(chunks(file.handle, signal));
    let response: TransferResponse | undefined;
    let transient = false;
    try {
      response = await request(file.url, { method: "PUT", headers: checkHeaders(file), body: stream, signal });
      if (response.status >= 200 && response.status < 300) {
        await unchanged(file);
        if (etag(response) !== file.md5) throw new TransferError("needs_verification", "Storage did not confirm this file's content digest. Verify it before finalizing.");
        return;
      }
      if (response.status === 412) {
        if (await verify(file, request, signal)) { await unchanged(file); return; }
        throw new TransferError("needs_verification", "This key already exists. A signed HEAD verification URL is needed to confirm its bytes; do not finalize yet.");
      }
      if ([401, 403].includes(response.status)) throw new TransferError("needs_fresh_urls", "Storage refused the upload signature; refresh create_upload for the same reservation.");
      transient = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!transient) throw new TransferError("failed", `Upload returned HTTP ${response.status}. No redirect was followed.`);
      if (await verify(file, request, signal)) { await unchanged(file); return; }
    } catch (error) {
      if (error instanceof TransferError) throw error;
      signal.throwIfAborted();
      // A failed connection can follow a committed PUT. A signed HEAD can prove it without overwriting.
      if (await verify(file, request, signal)) { await unchanged(file); return; }
      transient = true;
    } finally { stream.destroy(); }
    if (transient && attempt + 1 < RETRIES) await delay((deps.retryDelayMs ?? 500) * 2 ** attempt, undefined, { signal });
  }
  throw new TransferError("failed", "Upload failed after three attempts. Retry this same batch; completed files are retained.");
}

/** Streams only the explicitly supplied storage reservation. URLs never enter receipts or error messages. */
export async function uploadFiles(raw: unknown, deps: Dependencies): Promise<TransferResult> {
  const parsed = uploadFilesSchema.safeParse(raw);
  if (!parsed.success) return { status: "failed", requestId: "", takeId: "", uploadId: "", files: [], remaining: 0, error: "Invalid upload manifest. Supply paths, sizes, types and signed PUT URLs for one reservation." };
  const input = parsed.data;
  const base = { requestId: input.requestId, takeId: input.takeId, uploadId: input.uploadId };
  const completed: TransferReceipt[] = [];
  const result = (status: TransferResult["status"], error?: string): TransferResult => ({ ...base, status, files: completed, remaining: input.files.length - completed.length, ...(error ? { error } : {}) });
  const id = createHash("sha256").update(`${deps.scope}\0${input.requestId}`).digest("hex");
  const statePath = join(resolve(deps.stateDir), `${id}.json`);
  if (active.has(statePath)) return result("busy", "This batch is already transferring. Do not launch a duplicate.");
  active.add(statePath);
  const checked: CheckedFile[] = [];
  try {
    deps.signal?.throwIfAborted();
    const keys = new Set<string>();
    let target: string | undefined;
    // Validate the entire manifest before opening anything, then preflight every file before PUT.
    for (const file of input.files) {
      if (!isAbsolute(file.path) || /^[\\/]{2}/.test(file.path) || /[\x00-\x1f]/.test(file.path))
        throw new TransferError("failed", "Use an absolute local file path, not a network or device path.");
      const dest = destination(file.url, file.key, input.takeId);
      if (target && target !== dest.identity) throw new TransferError("failed", "A batch must belong to one storage account and bucket.");
      target = dest.identity;
      if (file.verificationUrl && destination(file.verificationUrl, file.key, input.takeId, true).identity !== target)
        throw new TransferError("failed", "The verification URL must identify the same object.");
      if (keys.has(file.key)) throw new TransferError("failed", "The manifest repeats a storage key.");
      keys.add(file.key);
      checkHeaders(file);
    }
    for (const file of input.files) {
      const handle = await open(file.path, "r");
      const item: CheckedFile = { ...file, handle, sha256: "", md5: "", mtime: 0, destination: target! };
      checked.push(item);
      const info = await handle.stat();
      if (!info.isFile() || info.size !== file.size) throw new TransferError("failed", "A local file is missing, is not a regular file, or has a different size.");
      item.mtime = info.mtimeMs;
      Object.assign(item, await digest(handle, deps.signal));
      await unchanged(item);
    }
    const fingerprint = createHash("sha256").update(JSON.stringify({ takeId: input.takeId, uploadId: input.uploadId, files: checked.map(f => ({ path: resolve(f.path), destination: f.destination, key: f.key, type: f.type, size: f.size, sha256: f.sha256 })) })).digest("hex");
    let saved: SavedReceipt = { fingerprint, files: [] };
    try { saved = JSON.parse(await readFile(statePath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new TransferError("failed", "The batch receipt is unreadable; preserve it and inspect before retrying."); }
    if (saved.fingerprint !== fingerprint || !Array.isArray(saved.files)) throw new TransferError("failed", "This request ID belongs to different files or another reservation. Do not reuse it for changed material.");
    await mkdir(deps.stateDir, { recursive: true, mode: 0o700 });
    const persist = async () => {
      const temporary = `${statePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ fingerprint, files: completed }, null, 2), { mode: 0o600 });
      await rename(temporary, statePath);
    };
    // Persist batch identity before the first PUT, even if the connection then fails.
    await writeFile(statePath, JSON.stringify(saved), { flag: "wx", mode: 0o600 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    for (const file of checked) {
      deps.signal?.throwIfAborted();
      const prior = saved.files.find(f => f.key === file.key && f.sha256 === file.sha256 && f.size === file.size && f.etag === file.md5);
      if (prior && (!file.verificationUrl || await verify(file, deps.request ?? sendTransfer, deps.signal ?? AbortSignal.timeout(FILE_TIMEOUT_MS)))) {
        completed.push(receipt(file, true));
      } else {
        await transfer(file, deps);
        completed.push(receipt(file, false));
      }
      await persist();
    }
    return result("uploaded");
  } catch (error) {
    if (deps.signal?.aborted || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) return result("cancelled", "Transfer stopped or timed out. Retry this same batch to resume completed files.");
    if (error instanceof TransferError) return result(error.status, error.message);
    // Filesystem and transport errors can include paths, URLs or credentials. Return only a bounded code.
    const code = (error as NodeJS.ErrnoException)?.code;
    return result("failed", ["ENOENT", "EACCES", "ENOSPC", "EPERM"].includes(code ?? "") ? `Local file transfer failed (${code}).` : "The file transfer failed. Preserve the batch and retry the same request.");
  } finally {
    await Promise.allSettled(checked.map(f => f.handle.close()));
    active.delete(statePath);
  }
}
