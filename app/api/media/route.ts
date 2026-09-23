import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { NextRequest } from "next/server";
import { api } from "@/convex/_generated/api";
import { convex, dashboardKey, LOCAL_MEDIA, MAX_BYTES, uploadDir } from "./store";

/** Keep an attached file on this machine. The chat registers its path afterwards. */
export async function POST(request: NextRequest) {
  if (!LOCAL_MEDIA) return Response.json({ error: "Local media is turned off." }, { status: 501 });
  const key = dashboardKey(request);
  if (!key) return Response.json({ error: "Unlock the dashboard first." }, { status: 401 });
  try {
    await convex().query(api.media.canStoreLocally, { key });
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
  const path = join(uploadDir(), `${randomUUID()}${/^[a-z0-9]{1,8}$/.test(extension) ? `.${extension}` : ""}`);
  await writeFile(path, bytes, { flag: "wx" });
  return Response.json({ path, size: bytes.length });
}
