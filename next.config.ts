import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Separate build output lets `next build` run alongside `next dev` during development.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  turbopack: { root: path.join(__dirname) },
  // Ship the committed snapshots with the serverless functions (fallback when the exchange blocks cloud IPs).
  outputFileTracingIncludes: { "/api/**": ["./data/snapshot/**"] },
};

export default nextConfig;
