import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createAccountWithOrg } from "./support/auth";
import { queryRows } from "./support/db";
import { createHierarchy } from "./support/hierarchy";

// S5 extraction guard: the follow-on chain (transcription → analysis →
// extraction, all mocked) populates grounded highlights, the panel's
// filter chips work (interactive-UI rule: every toggle gets exercised),
// and clicking a highlight seeks the player. DB-asserts the grounding
// invariant: every surfaced row aligned verbatim.

const FIXTURE_DIR = join(process.cwd(), "e2e", ".fixtures");
const FIXTURE = join(FIXTURE_DIR, "tiny-source.mp4");
const FIXTURE_SECONDS = 4;

const UPLOAD_TIMEOUT_MS = 60_000;
const PIPELINE_TIMEOUT_MS = 90_000;
const UPLOAD_BUTTON = /Upload 1 file/;
const UPLOAD_COMPLETE = /Complete/;
const SOURCE_PAGE_URL = /\/sources\//;
const FIND_HIGHLIGHTS = /Find highlights/;

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

test("highlights extract, filter, and seek the player", async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await createAccountWithOrg(page, "intel");
  await createHierarchy(page, Date.now().toString(36));

  await page.locator(".uppy-Dashboard-input").first().setInputFiles(FIXTURE);
  await page.getByRole("button", { name: UPLOAD_BUTTON }).click();
  await expect(page.locator(".uppy-StatusBar-statusPrimary")).toHaveText(
    UPLOAD_COMPLETE,
    { timeout: UPLOAD_TIMEOUT_MS }
  );

  const row = page.locator("[data-source-status]");
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await expect(row).toHaveAttribute("data-source-status", "ready", {
    timeout: PIPELINE_TIMEOUT_MS,
  });

  await page.getByRole("link", { name: "tiny-source" }).click();
  await page.waitForURL(SOURCE_PAGE_URL, { timeout: 60_000 });
  const sourceId = new URL(page.url()).pathname.split("/").pop() ?? "";

  // The follow-on chain lands while the poller refreshes the page.
  await expect(page.getByTestId("highlights-panel")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("highlight-item").first()).toBeVisible({
    timeout: 60_000,
  });

  // The grounding invariant, asserted where it lives: every row the run
  // produced from mock (verbatim) spans aligned, and only grounded rows
  // carry ranges inside the media.
  const [run] = await queryRows<{ revision: string; status: string }>(
    "SELECT status, revision FROM source_extraction_run WHERE source_id = $1",
    [sourceId]
  );
  expect(run.status).toBe("ready");
  expect(Number(run.revision)).toBe(1);
  const extractionRows = await queryRows<{
    classification: string | null;
    end_ms: string;
    grounded: boolean;
    kind: string;
    start_ms: string;
  }>(
    "SELECT kind, grounded, classification, start_ms, end_ms FROM source_extraction WHERE source_id = $1 ORDER BY start_ms",
    [sourceId]
  );
  expect(extractionRows.length).toBeGreaterThanOrEqual(4);
  for (const extraction of extractionRows) {
    expect(extraction.grounded).toBe(true);
    expect(Number(extraction.end_ms)).toBeGreaterThan(
      Number(extraction.start_ms)
    );
    expect(Number(extraction.end_ms)).toBeLessThanOrEqual(
      FIXTURE_SECONDS * 1000
    );
  }
  expect(new Set(extractionRows.map((extraction) => extraction.kind))).toEqual(
    new Set(["claim", "qa", "quote", "story"])
  );
  // The mock claim carries a rephrased statement — the aligner classifies
  // it deterministically.
  expect(
    extractionRows.find((extraction) => extraction.kind === "claim")
      ?.classification
  ).toBe("paraphrase");

  // Every filter chip is interactive UI — open each one (project rule).
  const allItems = page.getByTestId("highlight-item");
  const total = await allItems.count();
  for (const kind of ["quote", "story", "claim", "qa"]) {
    // biome-ignore lint/performance/noAwaitInLoops: chips are exercised one at a time by design
    await page.getByTestId(`highlight-filter-${kind}`).click();
    await expect(allItems).toHaveCount(
      extractionRows.filter((extraction) => extraction.kind === kind).length
    );
  }
  await page.getByTestId("highlight-filter-all").click();
  await expect(allItems).toHaveCount(total);

  // Clicking a highlight seeks the media element to its snapped start. The
  // last row (recording order) is guaranteed a non-zero start; earlier ones
  // can legitimately begin at 0ms (the qa row spans from the first word).
  const target = allItems.last();
  const startMs = Number(await target.getAttribute("data-start-ms"));
  expect(startMs).toBeGreaterThan(0);
  await target.click();
  await page.waitForFunction(
    (expected) => {
      const video = document.querySelector("video");
      return Boolean(video && Math.abs(video.currentTime - expected) < 0.5);
    },
    startMs / 1000,
    { timeout: 10_000 }
  );

  // ---- Ask & search (retrieval index + mock QA) ----
  const askPanel = page.getByTestId("ask-panel");
  await expect(askPanel).toBeVisible({ timeout: 60_000 });

  // Search mode: a meaning-level query lands the right chunk and seeks.
  await page.getByTestId("mode-search").click();
  await page
    .getByTestId("search-input")
    .fill("carries timestamps and confidence");
  await page.getByTestId("search-submit").click();
  const firstResult = page.getByTestId("search-result").first();
  await expect(firstResult).toBeVisible({ timeout: 20_000 });
  await firstResult.click();

  // Ask mode: an answerable question returns an answer with a citation
  // chip whose click seeks (and tries to play) the cited span.
  await page.getByTestId("mode-ask").click();
  await page
    .getByTestId("ask-input")
    .fill("What does every word carry — timestamps or confidence?");
  await page.getByTestId("ask-submit").click();
  await expect(page.getByTestId("qa-answer")).toBeVisible({ timeout: 30_000 });
  const citation = page.getByTestId("qa-citation").first();
  await expect(citation).toBeVisible();
  const citationStartMs = Number(await citation.getAttribute("data-start-ms"));
  await citation.click();
  await page.waitForFunction(
    (expected) => {
      const video = document.querySelector("video");
      // The player was parked >2s deep by the highlight click above, so
      // landing near the citation start is a real, observable seek.
      return Boolean(video && Math.abs(video.currentTime - expected) < 1);
    },
    citationStartMs / 1000,
    { timeout: 10_000 }
  );

  // Honesty: a question the recording does not cover renders an explicit
  // miss, never an empty answer.
  await page
    .getByTestId("ask-input")
    .fill("What subscription price does the purple elephant charge?");
  await page.getByTestId("ask-submit").click();
  await expect(page.getByTestId("qa-no-answer")).toBeVisible({
    timeout: 30_000,
  });

  // Both questions persisted with their verdicts; the query embeddings and
  // searches are on the ledger.
  const questionRows = await queryRows<{
    answerable: boolean | null;
    status: string;
  }>("SELECT answerable, status FROM source_question WHERE source_id = $1", [
    sourceId,
  ]);
  expect(questionRows).toHaveLength(2);
  expect(questionRows.every((question) => question.status === "ready")).toBe(
    true
  );
  expect(new Set(questionRows.map((question) => question.answerable))).toEqual(
    new Set([false, true])
  );
  const [qaLedger] = await queryRows<{ entries: string }>(
    `SELECT COUNT(*) AS entries FROM usage_ledger
      WHERE source_id = $1 AND entry_type = 'ai_tokens'
        AND (correlation_id LIKE 'qa:%' OR correlation_id LIKE 'search:%')`,
    [sourceId]
  );
  expect(Number(qaLedger.entries)).toBeGreaterThanOrEqual(3);

  // Pre-S5 backfill affordance: a source with a ready analysis but no
  // extraction run (the automatic chain only fires on fresh analyses)
  // shows a one-click "Find highlights" CTA that creates the first run.
  await queryRows("DELETE FROM source_extraction WHERE source_id = $1", [
    sourceId,
  ]);
  await queryRows("DELETE FROM source_extraction_run WHERE source_id = $1", [
    sourceId,
  ]);
  await page.reload();
  const findButton = page.getByTestId("rerun-extraction");
  await expect(findButton).toBeVisible({ timeout: 15_000 });
  await expect(findButton).toHaveText(FIND_HIGHLIGHTS);
  await findButton.click();
  await expect(page.getByTestId("highlight-item").first()).toBeVisible({
    timeout: 60_000,
  });

  expect(errors, errors.join("\n")).toEqual([]);
});
