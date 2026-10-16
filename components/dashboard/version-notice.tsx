"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { dashboardVersion, dashboardVersionDiffers } from "@/lib/dashboard-version";

const TAB_VERSION = dashboardVersion();
const NOTICE_ID = "perry-dashboard-version";

/** Mounted once by the sidebar. Reconnect already refreshes the status query. */
export function useVersionNotice(serverVersion: string | null | undefined) {
  useEffect(() => {
    if (!dashboardVersionDiffers(TAB_VERSION, serverVersion)) {
      toast.dismiss(NOTICE_ID);
      return;
    }
    toast.info("Perry has been updated", {
      id: NOTICE_ID,
      duration: Infinity,
      closeButton: true,
      description: "Finish your draft, then refresh to use the updated dashboard.",
      action: { label: "Refresh", onClick: () => window.location.reload() },
    });
    return () => { toast.dismiss(NOTICE_ID); };
  }, [serverVersion]);
}
