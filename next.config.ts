import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-hosted deploys (Dokploy) run the standalone server in Docker
  output: "standalone",
};

export default nextConfig;
