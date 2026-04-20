import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// CSP is set dynamically per-request in proxy.ts (nonce-based in production).
// All other headers are static and live here.
const securityHeaders = [
  // Clickjacking — belt-and-suspenders alongside frame-ancestors in CSP
  { key: "X-Frame-Options",        value: "DENY" },
  // Prevent MIME sniffing
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Referrer leakage control
  { key: "Referrer-Policy",        value: "strict-origin-when-cross-origin" },
  // Disable browser features the app doesn't use
  {
    key:   "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  // DNS prefetch — small latency win for Supabase calls
  { key: "X-DNS-Prefetch-Control", value: "on" },
  // HSTS — only meaningful on HTTPS; skip in dev to avoid breaking localhost
  ...(isProd
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source:  "/(.*)",
        headers: securityHeaders,
      },
    ];
  },

  // Don't advertise the framework
  poweredByHeader: false,

  // Trailing slash consistency
  trailingSlash: false,

  // Don't ship source maps to the browser in production
  ...(isProd && {
    productionBrowserSourceMaps: false,
  }),
};

export default nextConfig;
