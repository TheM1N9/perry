/**
 * Next config inlines this build's identity into both browser and server code.
 * Never read BUILD_ID from disk here: a replacement build can exist before the
 * running server has restarted. Unversioned builds and next dev stay quiet.
 */
export function dashboardVersion(): string | null {
  if (process.env.NODE_ENV !== "production") return null;
  const version = process.env.PERRY_UI_BUILD_ID;
  return version && /^[a-zA-Z0-9_-]{1,128}$/.test(version) ? version : null;
}

export function dashboardVersionDiffers(tab: string | null, server: string | null | undefined): boolean {
  return Boolean(tab && server && tab !== server);
}
