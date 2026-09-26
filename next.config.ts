import type { NextConfig } from "next";

const config: NextConfig = {
  // Next.js 16 blocks dev resources, hot reload among them, for any origin
  // other than localhost unless it is listed here. The dashboard is also opened
  // at 127.0.0.1, and from other devices over Tailscale by its 100.x address or
  // its ts.net name.
  allowedDevOrigins: ["127.0.0.1", "100.*.*.*", "**.ts.net"],
  // WhatsApp's client (server/whatsapp.ts) is loaded by Node as it ships, not bundled.
  serverExternalPackages: ["baileys", "qrcode"],
  // Pages that moved when the dashboard was rebuilt; old links and bookmarks still land.
  async redirects() {
    return [
      { source: "/tasks", destination: "/work", permanent: false },
      { source: "/about", destination: "/memory?tab=about", permanent: false },
      { source: "/profile", destination: "/settings", permanent: false },
      { source: "/keys", destination: "/settings?tab=keys", permanent: false },
      { source: "/setup", destination: "/settings?tab=telegram", permanent: false },
    ];
  },
};

export default config;
