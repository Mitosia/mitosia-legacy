import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createAccountWithOrg } from "./support/auth";
import { createHierarchy } from "./support/hierarchy";

// The one thing a "resumable" upload has to survive: the page going away.
// Before this suite existed, the file.id → sourceId mapping lived in a
// closure, so a reload could only start again from byte 0 — even though
// the server could already list every part storage was holding.
//
// The fixture is deliberately over 5 MB (Uppy's minimum part size, so the
// upload is genuinely multi-part) and over 10 MB (Golden Retriever's
// IndexedDB blob limit, so the browser cannot hand the file back and the
// user has to re-select it — the real UX for the multi-GB recordings this
// product is actually for).

const FIXTURE_DIR = join(process.cwd(), "e2e", ".fixtures");
const FIXTURE = join(FIXTURE_DIR, "resume-source.mp4");
const FIXTURE_SECONDS = 10;
const FIXTURE_MIN_BYTES = 11 * 1024 * 1024;

const PIPELINE_TIMEOUT_MS = 120_000;
const UPLOAD_TIMEOUT_MS = 60_000;
const UPLOAD_BUTTON = /Upload 1 file/;
const ADD_MORE_BUTTON = /Add more files/;
const UPLOAD_COMPLETE = /Complete/;
const RECOVERY_NOTICE = /could not fully recover/i;

// A presigned part upload: straight to storage, never to the app server.
function isPartUpload(url: URL) {
  return url.searchParams.has("partNumber") && url.searchParams.has("uploadId");
}

function partNumberOf(url: string) {
  return Number(new URL(url).searchParams.get("partNumber"));
}

test.beforeAll(() => {
  if (existsSync(FIXTURE)) {
    return;
  }
  mkdirSync(FIXTURE_DIR, { recursive: true });
  // Constant high bitrate so the size is predictable: testsrc2 is noisy
  // enough that x264 actually spends the bits it is given.
  execFileSync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=duration=${FIXTURE_SECONDS}:size=1280x720:rate=30`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${FIXTURE_SECONDS}`,
    "-c:v",
    "libx264",
    // ultrafast: CBR pins the size regardless of preset, nothing reads the
    // visual quality, and the default preset is what makes generating this
    // fixture slow on CI's 2-vCPU runner.
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    "20M",
    "-minrate",
    "20M",
    "-maxrate",
    "20M",
    "-bufsize",
    "4M",
    "-c:a",
    "aac",
    "-shortest",
    FIXTURE,
  ]);
});

test("an interrupted upload resumes after a reload instead of restarting", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // The fixture only proves anything if it is genuinely multi-part and too
  // big for Golden Retriever to stash the blob.
  const { size } = await import("node:fs/promises").then((fs) =>
    fs.stat(FIXTURE)
  );
  expect(size).toBeGreaterThan(FIXTURE_MIN_BYTES);

  const partsRequested: number[] = [];
  let stallLaterParts = true;

  await page.route(isPartUpload, async (route) => {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the flag is flipped by the test body at the interruption point
    if (stallLaterParts && partNumberOf(route.request().url()) > 1) {
      // Never settles. The tab is reloaded with these parts still in
      // flight, which is exactly the interruption under test — aborting
      // them instead would mark the file errored, and Uppy skips errored
      // files when it resumes a restored upload.
      await new Promise<never>(() => {
        // intentionally left pending
      });
      return;
    }
    partsRequested.push(partNumberOf(route.request().url()));
    await route.continue();
  });

  await createAccountWithOrg(page, "resume");
  await createHierarchy(page, Date.now().toString(36));

  // Part 1 must be durably stored before the interruption, otherwise there
  // is nothing for the resume to skip.
  const firstPartStored = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      isPartUpload(new URL(response.url())) &&
      response.status() === 200,
    { timeout: UPLOAD_TIMEOUT_MS }
  );

  await page.locator(".uppy-Dashboard-input").first().setInputFiles(FIXTURE);
  await page.getByRole("button", { name: UPLOAD_BUTTON }).click();
  await firstPartStored;

  // Interruption: everything in memory (Uppy's state, the source id) is
  // gone from here on; only localStorage and the server survive. The
  // stalling stops with it, so the resumed upload runs unimpeded.
  stallLaterParts = false;
  const partsBeforeReload = partsRequested.length;
  await page.reload();

  // Server-rendered after the reload: one source, still mid-upload. This is
  // the row the resumed upload must reuse rather than duplicate.
  const rows = page.locator("[data-source-status]");
  await expect(rows).toHaveAttribute("data-source-status", "uploading", {
    timeout: 15_000,
  });

  // Golden Retriever restored the file list, but a >10 MB blob cannot come
  // back with it, so the Dashboard asks for the file again.
  await expect(page.getByText(RECOVERY_NOTICE)).toBeVisible({
    timeout: 15_000,
  });

  await page.getByRole("button", { name: ADD_MORE_BUTTON }).click();
  await page.locator(".uppy-Dashboard-input").first().setInputFiles(FIXTURE);

  // Re-selecting the same file un-ghosts the restored entry (same Uppy file
  // id) rather than adding a second one, which re-enables the button.
  const resumeButton = page.getByRole("button", { name: UPLOAD_BUTTON });
  await expect(resumeButton).toBeEnabled({ timeout: 15_000 });
  await resumeButton.click();

  await expect(page.locator(".uppy-StatusBar-statusPrimary")).toHaveText(
    UPLOAD_COMPLETE,
    { timeout: UPLOAD_TIMEOUT_MS }
  );

  // The actual claim: the resumed upload picked up after the part storage
  // already held, instead of starting again at part 1.
  const resumedParts = partsRequested.slice(partsBeforeReload);
  expect(
    resumedParts.length,
    "the resume must upload the missing parts"
  ).toBeGreaterThan(0);
  expect(
    resumedParts,
    `part 1 was already stored; resuming re-uploaded it (parts seen: ${resumedParts.join(", ")})`
  ).not.toContain(1);

  // One source row, not two: the source id survived the reload, so no
  // second multipart upload (and no second ghost row) was ever created.
  await expect(rows).toHaveCount(1, { timeout: 15_000 });

  // Reaching "ready" proves the stitched object is a valid media file —
  // ffprobe and the whole pipeline ran on parts from two browser sessions.
  await expect(rows).toHaveAttribute("data-source-status", "ready", {
    timeout: PIPELINE_TIMEOUT_MS,
  });

  expect(errors, errors.join("\n")).toEqual([]);
});
