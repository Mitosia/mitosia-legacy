import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createAccountWithOrg } from "./support/auth";
import { quietUpload } from "./support/db";
import { createHierarchy } from "./support/hierarchy";

// upload-resume.spec.ts covers resuming when the browser still holds its
// half of the state. This covers the case where it does not — and that is
// one click away, because dismissing the recovery card drops the ghost, the
// source id and the multipart state with it.
//
// Observed on staging with the 2 GB exit-test recording: re-adding the same
// file opened a SECOND multipart upload, stranding 115 MB of parts under a
// duplicate row stuck at "uploading" — while the Dashboard promised the
// upload would carry on where it left off. The server can recognise the file
// on its own, so it does.
//
// Clearing localStorage and IndexedDB is the general form of the same
// condition (dismissed card, cleared site data, a different browser): the
// file arrives with no resume state whatsoever. It is also far less brittle
// than clicking a particular button inside Uppy's DOM.

const FIXTURE_DIR = join(process.cwd(), "e2e", ".fixtures");
const FIXTURE = join(FIXTURE_DIR, "adopt-source.mp4");
const FIXTURE_SECONDS = 10;
const FIXTURE_MIN_BYTES = 11 * 1024 * 1024;

// Comfortably past UPLOAD_ADOPT_GRACE_SECONDS (60) without approaching the
// 24h reaper window at the other end.
const QUIET_SECONDS = 300;

const PIPELINE_TIMEOUT_MS = 120_000;
const UPLOAD_TIMEOUT_MS = 60_000;
const UPLOAD_BUTTON = /Upload 1 file/;
const UPLOAD_COMPLETE = /Complete/;
const RECOVERY_NOTICE = /could not fully recover/i;

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

test("an upload is adopted when the browser kept no resume state", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const { size } = await import("node:fs/promises").then((fs) =>
    fs.stat(FIXTURE)
  );
  expect(size).toBeGreaterThan(FIXTURE_MIN_BYTES);

  const partsRequested: number[] = [];
  let stallLaterParts = true;

  await page.route(isPartUpload, async (route) => {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the flag is flipped by the test body at the interruption point
    if (stallLaterParts && partNumberOf(route.request().url()) > 1) {
      await new Promise<never>(() => {
        // intentionally left pending
      });
      return;
    }
    partsRequested.push(partNumberOf(route.request().url()));
    await route.continue();
  });

  await createAccountWithOrg(page, "adopt");
  await createHierarchy(page, Date.now().toString(36));

  const registered = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/uploads") &&
      response.request().method() === "POST"
  );
  const firstPartStored = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      isPartUpload(new URL(response.url())) &&
      response.status() === 200,
    { timeout: UPLOAD_TIMEOUT_MS }
  );

  await page.locator(".uppy-Dashboard-input").first().setInputFiles(FIXTURE);
  await page.getByRole("button", { name: UPLOAD_BUTTON }).click();
  const { sourceId } = (await (await registered).json()) as {
    sourceId: string;
  };
  await firstPartStored;

  stallLaterParts = false;
  const partsBeforeReload = partsRequested.length;

  // Everything the browser was holding, gone — the state Golden Retriever
  // would have restored from no longer exists.
  //
  // localStorage is the whole restore path: Golden Retriever keeps the file
  // list, our source id and @uppy/aws-s3's multipart state there, and only
  // the file *blobs* in IndexedDB. With no metadata there is nothing to
  // restore, so the blobs are ignored and later swept as orphans.
  //
  // Deliberately not deleting the IndexedDB database: the previous page's
  // connection is still closing, so `deleteDatabase` fires `onblocked` and
  // deletes nothing. An earlier version treated that as success, which made
  // this test pass or fail purely on timing.
  //
  // Cleared from a page that does not mount the uploader, so Uppy cannot
  // write its state back out from under us.
  const projectUrl = page.url();
  await page.goto("/dashboard");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await quietUpload(sourceId, QUIET_SECONDS);
  await page.goto(projectUrl);

  const rows = page.locator("[data-source-status]");
  await expect(rows).toHaveAttribute("data-source-status", "uploading", {
    timeout: 15_000,
  });

  // Nothing was restored, so the Dashboard is empty rather than showing a
  // ghost — this is a plain first-time file selection as far as it knows.
  await expect(page.getByText(RECOVERY_NOTICE)).toBeHidden();

  await page.locator(".uppy-Dashboard-input").first().setInputFiles(FIXTURE);
  const resumeButton = page.getByRole("button", { name: UPLOAD_BUTTON });
  await expect(resumeButton).toBeEnabled({ timeout: 15_000 });
  await resumeButton.click();

  await expect(page.locator(".uppy-StatusBar-statusPrimary")).toHaveText(
    UPLOAD_COMPLETE,
    { timeout: UPLOAD_TIMEOUT_MS }
  );

  // The claim: the server recognised the file and handed back the unfinished
  // upload, so the stored part was skipped rather than re-sent.
  const resumedParts = partsRequested.slice(partsBeforeReload);
  expect(
    resumedParts,
    `part 1 was already stored; the adopted upload re-sent it (parts seen: ${resumedParts.join(", ")})`
  ).not.toContain(1);

  // The damage this prevents: a second multipart upload under a second row,
  // with the first one's parts stranded until the reaper gets to them.
  await expect(rows).toHaveCount(1, { timeout: 15_000 });

  await expect(rows).toHaveAttribute("data-source-status", "ready", {
    timeout: PIPELINE_TIMEOUT_MS,
  });

  expect(errors, errors.join("\n")).toEqual([]);
});
