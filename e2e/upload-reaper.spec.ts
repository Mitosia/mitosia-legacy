import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createAccountWithOrg } from "./support/auth";
import { ageUpload } from "./support/db";
import { createHierarchy } from "./support/hierarchy";

// An upload the user never comes back to used to sit at "uploading" in the
// project list forever, while its parts stayed in the bucket. This covers
// the sweep that ends it: the project page notices the row is past its idle
// window and, after the response flushes, marks it failed and releases the
// storage-side multipart upload.
//
// Time is the awkward part — the window is a day — so the row is back-dated
// directly in the database, which is exactly what an abandoned upload looks
// like: `updated_at` stops moving once parts stop being signed.

const FIXTURE_DIR = join(process.cwd(), "e2e", ".fixtures");
const FIXTURE = join(FIXTURE_DIR, "abandoned-source.mp4");
const IDLE_HOURS = 25;

const UPLOAD_BUTTON = /Upload 1 file/;
const RETRY_BUTTON = /Retry/;
const ABANDONED_MESSAGE = /Upload never finished/;
const RETRY_REFUSAL = /This upload never finished/;

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
    "testsrc2=duration=2:size=320x180:rate=15",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
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

test("an abandoned upload is reaped instead of haunting the project list", async ({
  page,
}) => {
  test.setTimeout(120_000);

  // Every part hangs, so the upload never finishes and the source row stays
  // at "uploading" — an abandoned upload, minus the day of waiting.
  await page.route(
    (url) => url.searchParams.has("partNumber"),
    async () => {
      await new Promise<never>(() => {
        // intentionally left pending
      });
    }
  );

  await createAccountWithOrg(page, "reaper");
  await createHierarchy(page, Date.now().toString(36));

  const registered = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/uploads") &&
      response.request().method() === "POST"
  );
  await page.locator(".uppy-Dashboard-input").first().setInputFiles(FIXTURE);
  await page.getByRole("button", { name: UPLOAD_BUTTON }).click();
  const { sourceId } = (await (await registered).json()) as {
    sourceId: string;
  };

  const projectUrl = page.url();
  await page.goto(projectUrl);
  const row = page.locator("[data-source-status]");
  await expect(row).toHaveAttribute("data-source-status", "uploading", {
    timeout: 15_000,
  });

  await ageUpload(sourceId, IDLE_HOURS);

  // Rendering the list is what schedules the sweep; the RefreshPoller (still
  // running, because the row still reads "uploading") brings the result back.
  await page.goto(projectUrl);
  await expect(row).toHaveAttribute("data-source-status", "failed", {
    timeout: 30_000,
  });
  await expect(page.getByText(ABANDONED_MESSAGE)).toBeVisible();

  // Retry is offered for every failed source, but there is no original to
  // re-run here — it has to say so rather than queue a doomed pipeline run.
  await page.getByRole("button", { name: RETRY_BUTTON }).click();
  await expect(page.getByText(RETRY_REFUSAL)).toBeVisible({ timeout: 15_000 });
});
