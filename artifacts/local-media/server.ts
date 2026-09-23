// End-to-end check of the local media server, without a Codex turn:
// bun artifacts/local-media/server.ts <outDir> <dashboardKey> <perryHome>
// Needs `next dev -p 3005` running with PERRY_HOME=<perryHome>.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import type { Id } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";

const [, , outDir, key, perryHome] = process.argv;
const base = "http://localhost:3005";
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const cookie = (value: string) => ({ cookie: `perry_media=${encodeURIComponent(value)}` });

const chat = await convex.mutation(api.dashboard.createChat, { key });
const results: Record<string, any> = { chat };
try {
  // 1. An upload lands in the home's uploads folder.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const upload = await fetch(`${base}/api/media`, { method: "POST", headers: { ...cookie(key), "x-file-name": "dot.png" }, body: png });
  const { path: uploadPath } = await upload.json() as { path: string };
  results.upload = { status: upload.status, inUploads: uploadPath?.startsWith(join(perryHome, "uploads")) };
  results.uploadWithoutKey = (await fetch(`${base}/api/media`, { method: "POST", body: png })).status;

  // 2. A file the agent saved in its own folder is served from where it is.
  const agentFile = join(perryHome, "files", "notes", "hello.txt");
  mkdirSync(join(perryHome, "files", "notes"), { recursive: true });
  writeFileSync(agentFile, "hi from the agent's folder\n");
  const page = join(perryHome, "files", "page.html");
  writeFileSync(page, "<script>alert(1)</script>");
  const video = join(perryHome, "files", "clip.mp4");
  writeFileSync(video, Buffer.alloc(4096, 7));

  const register = (localPath: string, fileName: string, contentType: string, size: number) =>
    convex.mutation(api.dashboard.registerAttachment, { key, conversationId: chat, messageKey: "e2e", localPath, fileName, contentType, size });
  const ids = {
    upload: await register(uploadPath, "dot.png", "image/png", png.length),
    agentFile: await register(agentFile, "hello.txt", "text/plain", 27),
    page: await register(page, "page.html", "text/html", 25),
    video: await register(video, "clip.mp4", "video/mp4", 4096),
  };

  const get = async (id: Id<"chatAttachments"> | string, headers: Record<string, string> = cookie(key)) => {
    const response = await fetch(`${base}/api/media/${id}`, { headers });
    return { status: response.status, type: response.headers.get("content-type"), disposition: response.headers.get("content-disposition"), body: Buffer.from(await response.arrayBuffer()) };
  };
  const image = await get(ids.upload);
  const text = await get(ids.agentFile);
  const html = await get(ids.page);
  const range = await fetch(`${base}/api/media/${ids.video}`, { headers: { ...cookie(key), range: "bytes=100-199" } });
  results.served = {
    uploadedImage: { status: image.status, type: image.type, sameBytes: image.body.equals(png) },
    agentFile: { status: text.status, body: text.body.toString().trim() },
    html: { status: html.status, type: html.type, downloads: html.disposition?.startsWith("attachment") },
    videoRange: { status: range.status, contentRange: range.headers.get("content-range"), bytes: (await range.arrayBuffer()).byteLength },
  };
  results.refused = {
    noCookie: (await get(ids.upload, {})).status,
    wrongKey: (await get(ids.upload, cookie("wrong-key"))).status,
    unknownId: (await get("ks700000000000000000000000000000")).status,
  };
  results.pass = results.upload.status === 200 && results.upload.inUploads && results.uploadWithoutKey === 401
    && results.served.uploadedImage.status === 200 && results.served.uploadedImage.sameBytes && results.served.uploadedImage.type === "image/png"
    && results.served.agentFile.body === "hi from the agent's folder"
    && results.served.html.type === "application/octet-stream" && results.served.html.downloads
    && results.served.videoRange.status === 206 && results.served.videoRange.contentRange === "bytes 100-199/4096" && results.served.videoRange.bytes === 100
    && results.refused.noCookie === 401 && results.refused.wrongKey === 403 && results.refused.unknownId === 404;
} finally {
  await convex.mutation(api.dashboard.deleteChat, { key, id: chat });
}
results.ranAt = new Date().toISOString();
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "server.json"), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
process.exit(results.pass ? 0 : 1);
