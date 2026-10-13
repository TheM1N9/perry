import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { NextRequest } from "next/server";
import { dashboardKey, MAX_BYTES, query, uploadDir } from "./store";

/** Keep an attached file on this machine. The chat registers its path afterwards. */
export async function POST(request: NextRequest) {
  const key = dashboardKey(request);
  if (!key) return Response.json({ error: "Unlock the dashboard first." }, { status: 401 });
  try {
    await query("media:canStoreLocally", { key });
  } catch {
    return Response.json({ error: "Wrong dashboard key." }, { status: 403 });
  }

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) return Response.json({ error: "Attachments must be 50 MB or smaller." }, { status: 413 });
  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_BYTES) {
    return Response.json({ error: "Attachments must be between 1 byte and 50 MB." }, { status: 413 });
  }

  const extension = extname(decodeURIComponent(request.headers.get("x-file-name") ?? "")).slice(1).toLowerCase();
  const uploadId = request.headers.get("x-upload-id");
  if (uploadId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploadId)) {
    return Response.json({ error: "Invalid upload id." }, { status: 400 });
  }
  const path = join(uploadDir(), `${uploadId ?? randomUUID()}${/^[a-z0-9]{1,8}$/.test(extension) ? `.${extension}` : ""}`);
  try {
    await writeFile(path, bytes, { flag: "wx" });
  } catch (error) {
    if (!uploadId || !(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    if (!(await readFile(path)).equals(bytes)) return Response.json({ error: "This upload id already belongs to another file." }, { status: 409 });
  }
  return Response.json({ path, size: bytes.length });
}
