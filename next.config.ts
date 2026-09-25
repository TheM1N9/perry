import type { NextConfig } from "next";

const config: NextConfig = {
  // Next.js 16 blocks dev resources, hot reload among them, for any origin
  // other than localhost unless it is listed here. The dashboard is also opened
  // at 127.0.0.1, and from other devices over Tailscale by its 100.x address or
  // its ts.net name.
  allowedDevOrigins: ["127.0.0.1", "100.*.*.*", "**.ts.net"],
  // The Work page was renamed Tasks; old links and bookmarks still land there.
  async redirects() {
    return [{ source: "/work", destination: "/tasks", permanent: false }];
  },
};

export default config;
