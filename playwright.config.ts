// Specs that assert on database state need the connection strings in their
// own process; only the dev server would otherwise get them. Existing
// environment variables win, so CI's job env is unaffected.
import "dotenv/config";
import os from "node:os";
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
  // Parallelism is per spec FILE (fullyParallel stays false), so each file's
  // beforeAll fixture generation runs once, in one worker. CI worker count
  // scales with the runner (see `workers` below): every test provisions its
  // own account + organization, so RLS org-scoping keeps concurrent writers
  // invisible to each other, storage keys are org-prefixed, and Better
  // Auth's rate limiter is off in dev mode. Never exceed the hardware — 3
  // workers on the standard 2-vCPU runner piled ingest pipelines high
  // enough to blow serial-tuned timeouts (PR #62's first run). Local runs
  // stay serial — the shared dev DB also holds the developer's own data.
  fullyParallel: false,
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // `github` annotates PR failures; `list` prints per-test durations so the
  // CI log shows where the time goes.
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
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
    // The readiness probe doubles as a warm-up: pointing it at /sign-up makes
    // the dev server compile the route every test hits first BEFORE workers
    // launch, instead of all of them stampeding a cold compile at once.
    url: `${BASE_URL}/sign-up`,
  },
  // One less than the vCPU count — headroom for the dev server, MinIO and
  // the in-process ffmpeg pipelines the tests trigger — floored at 2 (the
  // standard 2-vCPU runner) and capped at 4 (11 tests in 8 files saturate
  // there). Adapts on its own when the E2E_RUNNER variable moves CI to a
  // larger runner (docs/ci-larger-runner.md).
  workers: process.env.CI
    ? Math.min(4, Math.max(2, os.availableParallelism() - 1))
    : 1,
});
