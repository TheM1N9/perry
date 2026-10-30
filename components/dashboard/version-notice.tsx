"use client";

import { dashboardVersion, dashboardVersionDiffers } from "@/lib/dashboard-version";

const TAB_VERSION = dashboardVersion();

/** The update control offers a reload when this tab is serving an older build. */
export function useVersionNotice(serverVersion: string | null | undefined) {
  return dashboardVersionDiffers(TAB_VERSION, serverVersion);
}
