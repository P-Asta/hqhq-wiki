import type { NextConfig } from "next";
import path from "node:path";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()"
  }
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Pin both roots so Next's multi-lockfile inference stays put on Windows.
  outputFileTracingRoot: path.resolve(process.cwd()),
  serverExternalPackages: ["firebase-admin", "better-sqlite3"],
  turbopack: {
    root: path.resolve(process.cwd())
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  }
};

export default nextConfig;
