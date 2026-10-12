import posthog from "posthog-js";
import { analyticsPath, scrubDashboardMetadata, trackDashboardEvent } from "./lib/analytics";

// This is a public ingestion key, not a personal API key. Overrides are baked in at build time.
const key = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "phc_qeCkb5s5b6x4T5adoyZWdCKsmwK27dKq3RginMwWAwqn";
const enabled = process.env.NEXT_PUBLIC_POSTHOG_ENABLED !== "false"
  && (process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_POSTHOG_ENABLED === "true");

if (enabled && key) {
  try {
    posthog.init(key, {
      api_host: "https://us.i.posthog.com",
      ui_host: "https://us.posthog.com",
      defaults: "2026-01-30",
      capture_pageview: "history_change",
      capture_pageleave: true,
      person_profiles: "always",
      respect_dnt: true,
      autocapture: { dom_event_allowlist: ["click"], capture_copied_text: false },
      mask_all_text: true,
      mask_all_element_attributes: true,
      disable_capture_url_hashes: true,
      save_campaign_params: false,
      save_referrer: false,
      // A personal assistant's DOM, console and network contain private content.
      disable_session_recording: true,
      enable_recording_console_log: false,
      capture_performance: { web_vitals: true, web_vitals_attribution: false, network_timing: false },
      capture_exceptions: false,
      disable_surveys: true,
      property_denylist: ["$title", "$initial_current_url", "$referrer", "$initial_referrer"],
      before_send: (event) => {
        if (!event) return null;
        scrubDashboardMetadata(event.properties);
        if (event.$set) scrubDashboardMetadata(event.$set);
        if (event.$set_once) scrubDashboardMetadata(event.$set_once);
        const path = analyticsPath(window.location.pathname);
        event.properties.$current_url = `https://perry.local${path}`;
        event.properties.$host = "perry.local";
        event.properties.$pathname = path;
        event.properties.app = "dashboard";
        event.properties.environment = process.env.NODE_ENV;
        return event;
      },
    });
    // Keep error frequency and category without private exception messages/stacks.
    window.addEventListener("error", () => trackDashboardEvent("Dashboard error", { kind: "uncaught_error" }));
    window.addEventListener("unhandledrejection", () => trackDashboardEvent("Dashboard error", { kind: "unhandled_rejection" }));
  } catch {
    // Perry still starts when analytics is unavailable.
  }
}
