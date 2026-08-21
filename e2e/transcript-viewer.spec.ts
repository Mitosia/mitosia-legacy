import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createAccountWithOrg } from "./support/auth";
import { createHierarchy } from "./support/hierarchy";

// Transcript viewer interactions (project rule: interactive UI is exercised
// by e2e, not by manual sweeps). Runs the real flow — upload, ingest, mock
// transcription — then drives the panel: click-to-seek, search, follow
// suppression. The mock provider (playwright.config.ts) yields a
// deterministic transcript, so text assertions are stable.

const FIXTURE_DIR = join(process.cwd(), "e2e", ".fixtures");
const FIXTURE = join(FIXTURE_DIR, "viewer-source.mp4");
const FIXTURE_SECONDS = 8;

const PIPELINE_TIMEOUT_MS = 90_000;
const UPLOAD_BUTTON = /Upload 1 file/;
const UPLOAD_COMPLETE = /Complete/;
const SOURCE_PAGE_URL = /\/sources\//;

test.beforeAll(() => {
  if (existsSync(FIXTURE)) {
    return;
  }
  mkdirSync(FIXTURE_DIR, { recursive: true });
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

test("the transcript panel seeks, searches, and highlights", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await createAccountWithOrg(page, "viewer");
  await createHierarchy(page, Date.now().toString(36));

  await page.locator(".uppy-Dashboard-input").first().setInputFiles(FIXTURE);
  await page.getByRole("button", { name: UPLOAD_BUTTON }).click();
  await expect(page.locator(".uppy-StatusBar-statusPrimary")).toHaveText(
    UPLOAD_COMPLETE,
    { timeout: 30_000 }
  );

  const row = page.locator("[data-source-status]");
  await expect(row).toHaveAttribute("data-source-status", "ready", {
    timeout: PIPELINE_TIMEOUT_MS,
  });

  await page.getByRole("link", { name: "viewer-source" }).click();
  await page.waitForURL(SOURCE_PAGE_URL, { timeout: 30_000 });

  // The mock transcription settles moments after ready; the poller swaps
  // the status card for the panel.
  const panel = page.getByTestId("transcript-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });

  // Deterministic mock content rendered with speaker chips
  await expect(panel.getByText("Welcome")).toBeVisible();
  await expect(page.getByTestId("transcript-speaker").first()).toHaveText(
    "Speaker 1"
  );

  // Low-confidence words carry the marker the viewer styles
  await expect(panel.locator("[data-low-confidence]").first()).toBeVisible();

  // Click-to-seek: the mock spreads words across the media duration, so a
  // late word seeks the video well past zero.
  const lastWord = panel.locator("button[data-start-ms]").last();
  const startMs = Number(await lastWord.getAttribute("data-start-ms"));
  expect(startMs).toBeGreaterThan(1000);
  await lastWord.click();
  await page.waitForFunction(
    (expectedSeconds) => {
      const video = document.querySelector("video");
      return Boolean(video && video.currentTime >= expectedSeconds - 0.5);
    },
    startMs / 1000,
    { timeout: 10_000 }
  );

  // …and the active-word highlight lands on a word at that time.
  await expect(panel.locator(".bg-primary\\/20").first()).toBeVisible({
    timeout: 5000,
  });

  // Search finds the mock's known words and reports match position
  await page.getByTestId("transcript-search").fill("word");
  await expect(page.getByTestId("transcript-match-count")).toContainText("of", {
    timeout: 5000,
  });
  await page.getByTestId("transcript-match-next").click();
  await expect(page.getByTestId("transcript-match-count")).toContainText(
    "2 of"
  );

  // A search jump suspends follow; the affordance to re-engage appears
  await expect(page.getByTestId("transcript-follow")).toBeVisible();
  await page.getByTestId("transcript-follow").click();
  await expect(page.getByTestId("transcript-follow")).toBeHidden();

  expect(errors, errors.join("\n")).toEqual([]);
});
