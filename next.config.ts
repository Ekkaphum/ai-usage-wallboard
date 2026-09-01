import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native addon; bundling it breaks the server build.
  serverExternalPackages: ['better-sqlite3'],
  // The dev overlay badge sits on top of a card on a wall-mounted screen.
  devIndicators: false,
  /* config options here */
};

export default nextConfig;
