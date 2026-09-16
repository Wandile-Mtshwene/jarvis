import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to this project so a stray package-lock.json in the
  // home directory doesn't make Next infer the wrong Turbopack root.
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;
