// Specs that assert on database state need the connection strings in their
// own process; only the dev server would otherwise get them. Existing
// environment variables win, so CI's job env is unaffected.
import "dotenv/config";
import { defineConfig, devices } from "@playwright/test";

// E2E runs against the dev server on 3001 — the origin BETTER_AUTH_URL is
// configured for, so auth requests are not rejected as cross-origin. The
// MenuGroupContext-class crash this suite guards against is a real React
// runtime error that surfaces identically in dev and prod, so dev is a
// faithful and far simpler target than the standalone production server.
// E2E_PORT overrides the port for runs alongside another checkout's server
// on 3001 (parallel worktree sessions) — set BETTER_AUTH_URL to match.
const PORT = Number(process.env.E2E_PORT ?? 3001);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  forbidOnly: !!process.env.CI,
  // Serial: shared local dev DB; parallel workers would interleave writes.
  fullyParallel: false,
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  reporter: process.env.CI ? "github" : "list",
  retries: process.env.CI ? 1 : 0,
  testDir: "./e2e",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  webServer: {
    command: `pnpm dev --port ${PORT}`,
    // The deterministic fake transcription provider: the CI fixture is a
    // sine wave with no speech, so a real provider can prove nothing here —
    // the mock exercises the full lifecycle instead. Note this only applies
    // to the server Playwright starts itself: a reused dev server (local
    // runs) must have TRANSCRIPTION_PROVIDER=mock in its own env or the
    // transcript assertions in source-ingest.spec.ts will time out.
    env: { ANALYSIS_PROVIDER: "mock", TRANSCRIPTION_PROVIDER: "mock" },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: BASE_URL,
  },
  workers: 1,
});
