import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createAccountWithOrg } from "./support/auth";
import { queryRows } from "./support/db";
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
const SRT_TIMING = /\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/;

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

  // Deterministic mock content rendered with speaker chips. The full
  // spaced sentence is the assertion on purpose: words are individual
  // inline-block buttons, and a trailing space *inside* a button collapses
  // — this caught paragraphs rendering as one unbroken string.
  await expect(
    panel.getByText("Welcome to the Mitosia mock transcript.")
  ).toBeVisible();
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
  await page.getByTestId("transcript-search").fill("");

  // Speaker naming — and the diarization-repair path: giving two ids the
  // SAME name is how an over-segmented voice gets merged, so that exact
  // flow is what gets exercised.
  await page.getByTestId("transcript-speakers").click();
  const speakersDialog = page.getByTestId("speaker-labels-dialog");
  await expect(speakersDialog).toBeVisible();
  await speakersDialog.getByLabel("Speaker 1").fill("Host");
  await speakersDialog.getByLabel("Speaker 2").fill("Host");
  await speakersDialog.getByTestId("speaker-labels-save").click();
  await expect(speakersDialog).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("transcript-speaker").first()).toHaveText(
    "Host",
    { timeout: 15_000 }
  );
  // Merged: every visible chip now carries the same name
  const chipTexts = await page
    .getByTestId("transcript-speaker")
    .allTextContents();
  expect(new Set(chipTexts)).toEqual(new Set(["Host"]));

  // Word correction: double-click → dialog → save produces a NEW revision
  // whose JSON the panel re-fetches.
  const firstWord = panel.locator("button[data-word-index='0']");
  await expect(firstWord).toHaveText("Welcome");
  await firstWord.dblclick();
  const correctDialog = page.getByTestId("correct-word-dialog");
  await expect(correctDialog).toBeVisible();
  await correctDialog.getByLabel("Replacement").fill("Greetings");
  await correctDialog.getByTestId("correct-word-save").click();
  await expect(correctDialog).toBeHidden({ timeout: 15_000 });
  await expect(panel.locator("button[data-word-index='0']")).toHaveText(
    "Greetings",
    { timeout: 15_000 }
  );

  const sourceId = new URL(page.url()).pathname.split("/").pop() ?? "";
  const revisions = await queryRows<{
    created_by: string | null;
    revision: string;
  }>(
    `SELECT r.revision, r.created_by
       FROM transcript_revision r JOIN transcript t ON t.id = r.transcript_id
      WHERE t.source_id = $1 ORDER BY r.revision`,
    [sourceId]
  );
  expect(revisions).toHaveLength(2);
  expect(revisions[0].created_by).toBeNull();
  expect(revisions[1].created_by).not.toBeNull();

  // Exports reflect the correction and the speaker merge immediately
  const srt = await page.request.get(
    `/api/sources/${sourceId}/transcript?format=srt`
  );
  expect(srt.status()).toBe(200);
  const srtBody = await srt.text();
  expect(srtBody).toContain("[Host]");
  expect(srtBody).toContain("Greetings");
  expect(srtBody).toMatch(SRT_TIMING);
  // Merge means no second speaker name survives anywhere
  expect(srtBody).not.toContain("Speaker 2");

  const vtt = await page.request.get(
    `/api/sources/${sourceId}/transcript?format=vtt`
  );
  expect(vtt.status()).toBe(200);
  const vttBody = await vtt.text();
  expect(vttBody.startsWith("WEBVTT")).toBe(true);
  expect(vttBody).toContain("<v Host>");

  // Analysis chains after transcription (mock analyzer): the lifecycle
  // lands ready with chapters, a summary, speaker suggestions, and the
  // context snapshot recorded for provenance.
  await expect
    .poll(
      async () => {
        const rows = await queryRows<{ status: string }>(
          "SELECT status FROM source_analysis WHERE source_id = $1",
          [sourceId]
        );
        return rows[0]?.status ?? "missing";
      },
      { timeout: 30_000 }
    )
    .toBe("ready");
  const [analysis] = await queryRows<{
    chapter_count: string;
    context_snapshot_id: string | null;
    speaker_suggestions: unknown;
    summary: string | null;
  }>(
    `SELECT a.summary, a.context_snapshot_id, a.speaker_suggestions,
            (SELECT count(*) FROM source_chapter c WHERE c.analysis_id = a.id)
              AS chapter_count
       FROM source_analysis a WHERE a.source_id = $1`,
    [sourceId]
  );
  expect(Number(analysis.chapter_count)).toBe(3);
  expect(analysis.summary).toBeTruthy();
  expect(analysis.context_snapshot_id).not.toBeNull();
  expect(Array.isArray(analysis.speaker_suggestions)).toBe(true);

  expect(errors, errors.join("\n")).toEqual([]);
});
