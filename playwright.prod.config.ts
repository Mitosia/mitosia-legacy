// `next dev` reads .env itself; the standalone server does not, so the
// config loads it here and Playwright passes it through to the server
// process. A no-op in CI, where the environment comes from the workflow.
import "dotenv/config";
import { defineConfig, devices } from "@playwright/test";

// Production-parity e2e. The main suite (playwright.config.ts) runs against
// `next dev`, which cannot see a whole class of defect: React reports
// hydration mismatches differently in development, `output: "standalone"`
// serves different assets, and dev never exercises the minified runtime. A
// hydration mismatch in the sidebar shipped to production behind exactly
// that blind spot (PR #19) — every dev-mode check was green.
//
// Kept as a separate config, not another project in the main one: this
// suite needs a `pnpm build` first, and `pnpm e2e` must stay runnable
// without one.
const PORT = 3002;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  forbidOnly: !!process.env.CI,
  fullyParallel: false,
  projects: [{ name: "chromium-prod", use: { ...devices["Desktop Chrome"] } }],
  reporter: process.env.CI ? "github" : "list",
  // No retries, even in CI. The bugs this suite exists to catch are timing
  // dependent and intermittent; a retry would silently paper over exactly
  // the signal we are here to collect.
  retries: 0,
  testDir: "./e2e-prod",
  use: { baseURL: BASE_URL, trace: "on-first-retry" },
  webServer: {
    command: "node scripts/serve-standalone.mjs",
    // The server's own origin must match BETTER_AUTH_URL or Better Auth
    // rejects every auth request as cross-origin. Port 3002 keeps this
    // suite from colliding with a dev server on 3001.
    env: { BETTER_AUTH_URL: BASE_URL, PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: BASE_URL,
  },
  workers: 1,
});
