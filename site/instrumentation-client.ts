import posthog from "posthog-js";

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
      autocapture: { capture_copied_text: false },
      disable_capture_url_hashes: true,
      mask_personal_data_properties: true,
      capture_dead_clicks: true,
      capture_heatmaps: true,
      capture_exceptions: true,
      capture_performance: { web_vitals: true, network_timing: false },
      enable_recording_console_log: false,
      session_recording: {
        maskAllInputs: true,
        blockSelector: ".ph-no-capture, input[type=hidden], input[type=file]",
        recordHeaders: false,
        recordBody: false,
      },
      before_send: (event) => {
        if (!event) return null;
        event.properties.app = "website";
        event.properties.environment = process.env.NODE_ENV;
        return event;
      },
    });
  } catch {
    // Tracking must never prevent the landing page from loading.
  }
}
