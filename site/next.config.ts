import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // site/ is its own project inside the Perry repo, which has a lockfile of its own at the root.
  turbopack: { root: import.meta.dirname },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
