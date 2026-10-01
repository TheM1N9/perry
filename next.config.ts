import type { NextConfig } from "next";

const config: NextConfig = {
  // Next.js 16 blocks dev resources, hot reload among them, for any origin
  // other than localhost unless it is listed here. The dashboard is also opened
  // at 127.0.0.1, and from other devices over Tailscale by its 100.x address or
  // its ts.net name.
  allowedDevOrigins: ["127.0.0.1", "100.*.*.*", "**.ts.net"],
  // WhatsApp's client (server/whatsapp.ts) is loaded by Node as it ships, not bundled.
  serverExternalPackages: ["baileys", "qrcode"],
  // Pages that moved when the dashboard was rebuilt, and again when Settings
  // took sections; old links and bookmarks still land. A query goes along, so
  // /activity?session=…, /skills?skill=… and Composio's way back to
  // /connectors?connected=… keep working. Settings' old ?tab= links are
  // proxy.ts's to send on, without the ?tab=.
  async redirects() {
    return [
      { source: "/tasks", destination: "/work", permanent: false },
      { source: "/about", destination: "/memory?tab=about", permanent: false },
      { source: "/profile", destination: "/settings/general", permanent: false },
      { source: "/keys", destination: "/settings/logins", permanent: false },
      { source: "/setup", destination: "/settings/telegram", permanent: false },
      { source: "/apps", destination: "/apps/connectors", permanent: false },
      { source: "/connectors", destination: "/apps/connectors", permanent: false },
      { source: "/skills", destination: "/apps/skills", permanent: false },
      { source: "/computer", destination: "/settings/computers", permanent: false },
      { source: "/activity", destination: "/settings/activity", permanent: false },
    ];
  },
};

export default config;
