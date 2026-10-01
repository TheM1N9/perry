import { track } from "@vercel/analytics";

/**
 * The custom events the site sends to Vercel Web Analytics. The dashboard
 * groups by these names and properties, so renaming one starts a new series.
 */
type Events = {
  /** A button that takes the reader to the installer, or to the day with Perry. */
  "CTA click": { cta: "get_perry" | "see_day"; from: "nav" | "hero" | "close" };
  /** A link out to the repo on GitHub. */
  "GitHub click": { link: "repo" | "install_guide" };
  /** A Copy button in Setup; `copied` is false when the browser refused the clipboard. */
  "Copy command": { command: "install" | "run"; os: "unix" | "windows"; copied: boolean };
};

export type EventName = keyof Events;
export type EventData<E extends EventName> = Events[E];

export function trackEvent<E extends EventName>(name: E, data: Events[E]) {
  track(name, data);
}
