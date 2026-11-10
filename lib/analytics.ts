import posthog from "posthog-js";

/** Only structural routes leave the local dashboard; never IDs, queries or keys. */
export function analyticsPath(pathname: string): string {
  return pathname.replace(/^\/(chat|brain|library|projects)\/[^/]+/, "/$1/:id");
}

/** PostHog also attaches entry URLs and person properties, including nested $set_once. */
export function scrubDashboardMetadata(properties: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(properties)) {
    if (/url|pathname|host|referr|title|utm_|\$elements|\$el_text/i.test(key)) {
      delete properties[key];
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object") scrubDashboardMetadata(item);
      }
    } else if (value && typeof value === "object") {
      scrubDashboardMetadata(value as Record<string, unknown>);
    }
  }
}

export function trackDashboardEvent(name: string, properties: Record<string, string | number | boolean> = {}) {
  if (typeof window === "undefined") return;
  try {
    posthog.capture(name, properties);
  } catch {
    // Analytics must never interrupt an operation in Perry.
  }
}
