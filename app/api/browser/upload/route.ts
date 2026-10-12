import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { z } from "zod";
import { browserIdentity } from "@/lib/browser-protocol";
import * as browser from "@/convex/lib/browser";
import { PATHS } from "@/runner/home";
import { authorizeBrowser, browserFailure } from "@/server/browser-api";
import { browserStatus } from "@/server/browser-host";
import { backend } from "@/server/index";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const scope = request.headers.get("x-perry-chat") ?? "";
    const { importEnabled } = await authorizeBrowser(request, scope);
    const expected = browserIdentity.parse(JSON.parse(request.headers.get("x-browser-identity") ?? "null"));
    browser.checkIdentity(expected, scope);
    const state = browser.browserControl(scope);
    if (state.controller !== "owner" || state.upload === null) throw new Error("Take over and choose a file field in the browser first.");
    const limit = 50 * 1024 * 1024;
    if (Number(request.headers.get("content-length") ?? 0) > limit) return Response.json({ error: "Files must be 50 MB or smaller." }, { status: 413 });
    const bytes = Buffer.from(await request.arrayBuffer());
    if (!bytes.length || bytes.length > limit) return Response.json({ error: "Files must be between 1 byte and 50 MB." }, { status: 413 });
    browser.checkIdentity(expected, scope);
    const name = decodeURIComponent(request.headers.get("x-file-name") ?? "upload").slice(0, 200);
    const extension = extname(name).slice(1).toLowerCase();
    mkdirSync(PATHS.uploads, { recursive: true, mode: 0o700 });
    const path = join(PATHS.uploads, `${randomUUID()}${/^[a-z0-9]{1,8}$/.test(extension) ? `.${extension}` : ""}`);
    writeFileSync(path, bytes, { mode: 0o600 });
    await browser.withOwnerBrowser(scope, async () => {
      await browser.hostCommand("DOM.setFileInputFiles", { files: [path], backendNodeId: state.upload });
      state.upload = null;
      await backend().runMutation("library:add", { path, name, by: "owner", how: "added", conversationId: scope }, { internal: true });
    });
    return Response.json(await browserStatus(scope, importEnabled), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return browserFailure(error); }
}
