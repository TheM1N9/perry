import type { NextRequest } from "next/server";
import { ensureHome } from "@/runner/home";

/**
 * Local media: chat files that stay on this machine.
 *
 * Each attachment records where its file lives, usually somewhere in
 * Assistant's home (runner/home.ts), and this server serves it from there.
 * Files the owner attaches land in the home's uploads folder. The runner on
 * the same machine reads the same paths, so Codex opens attachments straight
 * from disk.
 */
export function uploadDir(): string {
  return ensureHome().uploads;
}
export const MAX_BYTES = 50 * 1024 * 1024;

/** Media requests carry the dashboard key in a path-scoped cookie, never in the URL. */
export const MEDIA_COOKIE = "perry_media";

export function dashboardKey(request: NextRequest): string | null {
  return request.cookies.get(MEDIA_COOKIE)?.value || null;
}

/** Call a public backend function, as the browser would, in this same process. */
export async function query<T>(path: string, args: Record<string, unknown>): Promise<T> {
  const { backend } = await import("@/server/index");
  return (await backend().runQuery(path, args)).value as T;
}
