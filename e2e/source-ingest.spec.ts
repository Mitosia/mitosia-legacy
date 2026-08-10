import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createAccountWithOrg } from "./support/auth";

// S2 exit-test guard, scaled down for CI-speed: a real media file goes
// through the real flow — Uppy multipart upload to MinIO, the ingest
// pipeline (ffmpeg), and playback through the media proxy with waveform
// scrubbing. Requires docker compose services (Postgres + MinIO) and a
// local ffmpeg, same as `pnpm dev`.

// Relative to the repo root (playwright runs from it); import.meta/__dirname
// are both unavailable in Playwright's CommonJS transpilation of specs.
const FIXTURE_DIR = join(process.cwd(), "e2e", ".fixtures");
const FIXTURE = join(FIXTURE_DIR, "tiny-source.mp4");
const FIXTURE_SECONDS = 4;

const PIPELINE_TIMEOUT_MS = 90_000;
const UPLOAD_TIMEOUT_MS = 30_000;
const UPLOAD_BUTTON = /Upload 1 file/;
const UPLOAD_COMPLETE = /Complete/;
const SOURCE_PAGE_URL = /\/sources\//;

test.beforeAll(() => {
  if (existsSync(FIXTURE)) {
    return;
  }
  mkdirSync(FIXTURE_DIR, { recursive: true });
  // Synthetic 640×360 test pattern with a 440 Hz tone — small enough to
  // upload in one part, rich enough to exercise every pipeline step.
  execFileSync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=duration=${FIXTURE_SECONDS}:size=640x360:rate=30`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${FIXTURE_SECONDS}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    FIXTURE,
  ]);
});

async function createHierarchy(page: import("@playwright/test").Page) {
  await page.goto("/clients");
  await page.getByLabel("New client").fill("E2E Media Client");
  await page.getByRole("button", { name: "Add client" }).click();
  await page.getByRole("link", { name: "E2E Media Client" }).click();

  await page.getByLabel("New brand").fill("E2E Brand");
  await page.getByRole("button", { name: "Add brand" }).click();
  await page.getByRole("link", { name: "E2E Brand" }).click();

  await page.getByLabel("New campaign").fill("E2E Campaign");
  await page.getByRole("button", { name: "Add campaign" }).click();
  await page.getByRole("link", { name: "E2E Campaign" }).click();

  await page.getByLabel("New project").fill("E2E Project");
  await page.getByRole("button", { name: "Add project" }).click();
  await page.getByRole("link", { name: "E2E Project" }).click();
}

test("a recording uploads, ingests, and plays as proxy with waveform scrubbing", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Console errors (e.g. hls.js fatal errors, failed media fetches) are the
  // only diagnostics available when playback fails headlessly in CI.
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("requestfailed", (request) => {
    consoleErrors.push(
      `requestfailed: ${request.url()} (${request.failure()?.errorText})`
    );
  });

  await createAccountWithOrg(page, "ingest");
  await createHierarchy(page);

  // Upload through the Uppy dashboard (multipart to storage, not the app).
  await page.locator(".uppy-Dashboard-input").first().setInputFiles(FIXTURE);
  await page.getByRole("button", { name: UPLOAD_BUTTON }).click();
  await expect(page.locator(".uppy-StatusBar-statusPrimary")).toHaveText(
    UPLOAD_COMPLETE,
    { timeout: UPLOAD_TIMEOUT_MS }
  );

  // The source row appears and the pipeline drives it to ready.
  const row = page.locator("[data-source-status]");
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await expect(row).toHaveAttribute("data-source-status", "ready", {
    timeout: PIPELINE_TIMEOUT_MS,
  });

  // The list poster is served through /api/media from a pipeline artifact.
  await expect(row.locator("img")).toBeVisible({ timeout: 10_000 });

  // Open the source page: proxy playback + waveform. The click can race a
  // RefreshPoller re-render (server components swap the list mid-click),
  // so wait for the URL rather than trusting a single click's navigation.
  await page.getByRole("link", { name: "tiny-source" }).click();
  await page.waitForURL(SOURCE_PAGE_URL, { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "tiny-source" })).toBeVisible({
    timeout: 15_000,
  });

  // hls.js must load the master playlist and segments through /api/media —
  // a real duration on the video element proves the whole delivery path.
  await page
    .waitForFunction(
      (minimum) => {
        const video = document.querySelector("video");
        return Boolean(video && video.duration > minimum);
      },
      FIXTURE_SECONDS - 1.5,
      { timeout: 60_000 }
    )
    .catch((error) => {
      throw new Error(
        `video duration never loaded; console errors: ${consoleErrors.join(" | ") || "(none)"}`,
        { cause: error }
      );
    });

  // A FULL document load of the source page must succeed too — client-side
  // navigation skips SSR, which once hid a peaks.js `window` reference
  // that 500'd every hard refresh of this route.
  const documentResponse = await page.goto(page.url());
  expect(documentResponse?.status()).toBe(200);

  // peaks.js paints the precomputed waveform into a canvas.
  const waveform = page.getByTestId("waveform-overview");
  await expect(waveform.locator("canvas").first()).toBeVisible({
    timeout: 15_000,
  });

  // Waveform scrubbing: clicking the overview seeks the media element.
  await waveform.click({ position: { x: 200, y: 40 } });
  await page.waitForFunction(
    () => {
      const video = document.querySelector("video");
      return Boolean(video && video.currentTime > 0.5);
    },
    undefined,
    { timeout: 10_000 }
  );

  expect(errors, errors.join("\n")).toEqual([]);
});
