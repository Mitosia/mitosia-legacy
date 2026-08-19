import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Without this, a failed RSC fetch falls back to a *browser* navigation
    // (`fetchServerResponse` returns the URL on error → MPA nav). With no
    // network that lands on the browser's own error page, destroying client
    // state — which is how a connectivity blip replaced a project page with
    // Chrome's dinosaur mid-upload. The 3.5s RefreshPoller made hitting it a
    // matter of seconds rather than luck.
    //
    // Enabled, Next keeps a failed navigation, RSC fetch, prefetch or Server
    // Action pending and retries it when the connection returns, and exposes
    // `useOffline()` so the UI can say so (components/app/offline-banner).
    useOffline: true,
  },
  // Self-hosted deploys (Dokploy) run the standalone server in Docker
  output: "standalone",
};

export default nextConfig;
