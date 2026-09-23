import { ConvexHttpClient } from "convex/browser";
import type { NextRequest } from "next/server";
import { ensureHome } from "@/runner/home.mjs";

/**
 * Local media: chat files that stay on this machine.
 *
 * Each attachment records where its file lives, usually somewhere in
 * Assistant's home (runner/home.mjs), and this server serves it from there.
 * Files the owner attaches land in the home's uploads folder. The runner on
 * the same machine reads the same paths, so Codex opens attachments straight
 * from disk. Set PERRY_MEDIA=convex when the dashboard is hosted elsewhere;
 * uploads then go to Convex storage.
 */
export function uploadDir(): string {
  return ensureHome().uploads;
}
export const LOCAL_MEDIA = process.env.PERRY_MEDIA !== "convex";
export const MAX_BYTES = 50 * 1024 * 1024;

/** Media requests carry the dashboard key in a path-scoped cookie, never in the URL. */
export const MEDIA_COOKIE = "perry_media";

export function dashboardKey(request: NextRequest): string | null {
  return request.cookies.get(MEDIA_COOKIE)?.value || null;
}

export function convex(): ConvexHttpClient {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set.");
  return new ConvexHttpClient(url);
}
