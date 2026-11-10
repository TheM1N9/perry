import { randomUUID } from "node:crypto";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import type { NextConfig } from "next";

const config: NextConfig = {
  // Next.js 16 blocks dev resources, hot reload among them, for any origin
  // other than localhost unless it is listed here. The dashboard is also opened
  // at 127.0.0.1, and from other devices over Tailscale by its 100.x address or
  // its ts.net name.
  allowedDevOrigins: ["127.0.0.1", "100.*.*.*", "**.ts.net"],
  // WhatsApp's client (server/whatsapp.ts) is loaded by Node as it ships, not bundled.
  serverExternalPackages: ["baileys", "qrcode"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        // Media/PDF API responses must remain embeddable by Perry's own file viewer.
        source: "/((?!api/).*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
        ],
      },
    ];
  },
  // Pages that moved when the dashboard was rebuilt, and again when Settings
  // took sections; old links and bookmarks still land. A query goes along, so
  // /activity?session=…, /skills?skill=… and Composio's way back to
  // /connectors?connected=… keep working. Settings' old ?tab= links are
  // proxy.ts's to send on, without the ?tab=.
  async redirects() {
    return [
      { source: "/tasks", destination: "/work", permanent: false },
      { source: "/about", destination: "/brain?open=about", permanent: false },
      // Memory and Notes became Brain (issue #210): a page, a search, and the old About you all land there.
      { source: "/memory", destination: "/brain", permanent: false },
      { source: "/notes", destination: "/brain", permanent: false },
      { source: "/notes/:id", destination: "/brain/:id", permanent: false },
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

export default function nextConfig(phase: string): NextConfig {
  // One identity compiled into both sides of this build. At next start the
  // compiled modules keep their inlined value; this config must not invent a
  // runtime version or inspect a replacement build sitting on disk.
  // Compiler workers reload config and inherit this build's environment.
  const uiBuildId = phase === PHASE_PRODUCTION_BUILD
    ? (process.env.PERRY_UI_BUILD_ID ??= randomUUID())
    : "";
  return {
    ...config,
    env: { PERRY_UI_BUILD_ID: uiBuildId },
    // Reuse the identity as Next's native build ID. When a deploymentId is
    // supplied Next uses a constant BUILD_ID instead; our compiled token still
    // distinguishes separate builds without enabling automatic navigation.
    generateBuildId: () => uiBuildId || null,
  };
}
