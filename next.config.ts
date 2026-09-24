import type { NextConfig } from "next";

const config: NextConfig = {
  // The Work page was renamed Tasks; old links and bookmarks still land there.
  async redirects() {
    return [{ source: "/work", destination: "/tasks", permanent: false }];
  },
};

export default config;
