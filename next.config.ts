import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["playwright", "playwright-extra", "puppeteer-extra-plugin-stealth"],
  // Inline public env vars for Docker builds where they aren't available at build time.
  // Self-hosters: set NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY in your
  // Docker build environment (Railway: project-level env vars). Fail closed if missing.
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  },
};

export default nextConfig;
