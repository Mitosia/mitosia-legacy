import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createAccountWithOrg } from "./support/auth";
import { queryRows, stallIngest } from "./support/db";
import { createHierarchy } from "./support/hierarchy";

// An ingest whose process is hard-killed never runs recordFailure, so the
// row keeps claiming "processing" and the UI shows a step that will never
// advance. Seen for real: the first Trigger.dev run was OOM-killed mid-
// ladder and left a source on "Preparing playback" with a null
// ingest_error — nothing in the row said anything had gone wrong, and
// nothing would ever change it.
//
// Time is the awkward part again (the window is half an hour), so the row
// is put into the exact state a killed process leaves behind and back-dated.

const FIXTURE_DIR = join(process.cwd(), "e2e", ".fixtures");
const FIXTURE = join(FIXTURE_DIR, "stalled-source.mp4");
const STALL_MINUTES = 31;

const UPLOAD_BUTTON = /Upload 1 file/;
const STALLED_MESSAGE = /Processing stopped unexpectedly/;

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

test("an ingest whose process died is reaped instead of processing forever", async ({
  page,
}) => {
  test.setTimeout(180_000);

  await createAccountWithOrg(page, "ingestreaper");
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
  const row = page.locator("[data-source-status]");

  // Let the real pipeline finish first, so the row this test stalls is one
  // the app itself produced rather than a shape invented by the test. Waits
  // on the live page rather than navigating: a reload here would interrupt
  // the upload still in flight, which is how this test first failed.
  await expect(row).toHaveAttribute("data-source-status", "ready", {
    timeout: 120_000,
  });

  await stallIngest(sourceId, STALL_MINUTES);

  // Rendering the list is what schedules the sweep; the RefreshPoller starts
  // again on its own because the row now reads "processing", and carries the
  // transition to failed back to the page.
  await page.goto(projectUrl);
  await expect(row).toHaveAttribute("data-source-status", "failed", {
    timeout: 60_000,
  });
  await expect(page.getByText(STALLED_MESSAGE)).toBeVisible();

  // The step it died on is the one diagnostic worth keeping.
  const audits = await queryRows<{ action: string; metadata: unknown }>(
    "select action, metadata from audit_log where entity_id = $1 and action = 'source.ingest_stalled'",
    [sourceId]
  );
  expect(audits).toHaveLength(1);
  expect(JSON.stringify(audits[0].metadata)).toContain("hls");
});
