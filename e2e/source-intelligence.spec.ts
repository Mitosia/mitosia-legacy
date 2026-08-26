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
const INDEX_FAILURE = /Voyage embeddings failed \(429\)/;
const ONE_ACCEPTED = /1 accepted/;
const ONE_ACCEPTED_ONE_REJECTED = /1 accepted · 1 rejected/;
const RERUN_REFUSAL = /review decisions/;
const SEGMENT_RERUN_REFUSAL = /review decisions/;
const REVIEW_TRIM_END = /Reviewer: trim end/;

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

  // S6: extraction success chains moment discovery (mocked). The run must
  // land ready with grounded, sentence-snapped candidates inside the media,
  // the mock's deliberate near-duplicate visibly suppressed by dedupe, and
  // the high-risk item flagged sensitive — the whole deterministic gauntlet
  // proven from the database.
  await expect
    .poll(
      async () => {
        const [discovery] = await queryRows<{ status: string }>(
          "SELECT status FROM moment_discovery_run WHERE source_id = $1",
          [sourceId]
        );
        return discovery?.status ?? "missing";
      },
      { timeout: 60_000 }
    )
    .toBe("ready");
  const candidateRows = await queryRows<{
    dedupe_group: number | null;
    end_ms: string;
    grounded: boolean;
    rank: string;
    sensitive: boolean;
    start_ms: string;
    suppressed: boolean;
  }>(
    "SELECT grounded, sensitive, suppressed, dedupe_group, rank, start_ms, end_ms FROM moment_candidate WHERE source_id = $1 ORDER BY rank",
    [sourceId]
  );
  expect(candidateRows.length).toBeGreaterThanOrEqual(4);
  for (const candidate of candidateRows) {
    expect(candidate.grounded).toBe(true);
    expect(Number(candidate.end_ms)).toBeGreaterThan(
      Number(candidate.start_ms)
    );
    expect(Number(candidate.end_ms)).toBeLessThanOrEqual(
      FIXTURE_SECONDS * 1000
    );
  }
  expect(candidateRows.map((candidate) => Number(candidate.rank))).toEqual(
    candidateRows.map((_, index) => index)
  );
  const survivors = candidateRows.filter((candidate) => !candidate.suppressed);
  const suppressed = candidateRows.filter((candidate) => candidate.suppressed);
  expect(survivors.length).toBeGreaterThanOrEqual(3);
  expect(suppressed).toHaveLength(1);
  // The loser shares its dedupe group with a kept candidate.
  expect(suppressed[0]?.dedupe_group).not.toBeNull();
  expect(
    survivors.some(
      (candidate) => candidate.dedupe_group === suppressed[0]?.dedupe_group
    )
  ).toBe(true);
  expect(candidateRows.filter((candidate) => candidate.sensitive)).toHaveLength(
    1
  );

  // Lead-in capture: the sensitive candidate (rank 1) is the mock's
  // second-paragraph moment — it opens with the OTHER speaker's short
  // preceding turn folded in, so its span starts at 0 while the model's
  // raw claim started at the answer.
  const [leadInRow] = await queryRows<{
    raw_start_ms: string;
    start_ms: string;
  }>(
    "SELECT start_ms, raw_start_ms FROM moment_candidate WHERE source_id = $1 AND rank = 1",
    [sourceId]
  );
  expect(Number(leadInRow.start_ms)).toBe(0);
  expect(Number(leadInRow.raw_start_ms)).toBeGreaterThan(0);

  // Reviewer agent (S6 §9): mock mode always reviews, so every surviving
  // candidate carries a cold verdict and the mock's deterministic flag
  // (last survivor, trim_end) is provable — columns and badge both.
  const reviewRows = await queryRows<{
    rank: string;
    review_fix: string | null;
    review_scores: unknown;
  }>(
    "SELECT rank, review_fix, review_scores FROM moment_candidate WHERE source_id = $1 AND suppressed = false ORDER BY rank",
    [sourceId]
  );
  expect(
    reviewRows.every((candidate) => candidate.review_scores !== null)
  ).toBe(true);
  const flaggedRows = reviewRows.filter(
    (candidate) => candidate.review_fix !== "none"
  );
  expect(flaggedRows).toHaveLength(1);
  expect(flaggedRows[0]?.review_fix).toBe("trim_end");

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

  // ---- Moments review UI (S6) ----
  const momentsPanel = page.getByTestId("moments-panel");
  await expect(momentsPanel).toBeVisible({ timeout: 60_000 });
  const momentItems = page.getByTestId("moment-item");
  await expect
    .poll(() => momentItems.count(), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId("moment-sensitive")).toHaveCount(1);
  await expect(page.getByTestId("moment-review-flag")).toHaveCount(1);
  await expect(page.getByTestId("moment-review-flag")).toHaveText(
    REVIEW_TRIM_END
  );

  // Play-from-in-point seeks to the exact in-point; a card click then
  // applies the 3s pre-roll (clamped to 0 on this tiny fixture) — the two
  // together prove both halves of the playback contract.
  const thirdCard = momentItems.nth(2);
  await thirdCard.getByTestId("moment-play-in").click();
  const thirdStartMs = Number(
    await thirdCard.getByTestId("moment-card").getAttribute("data-start-ms")
  );
  expect(thirdStartMs).toBeGreaterThan(0);
  await page.waitForFunction(
    (expected) => {
      const video = document.querySelector("video");
      return Boolean(video && Math.abs(video.currentTime - expected) < 0.5);
    },
    thirdStartMs / 1000,
    { timeout: 10_000 }
  );
  await thirdCard.getByTestId("moment-card").click();
  await page.waitForFunction(
    (expected) => {
      const video = document.querySelector("video");
      return Boolean(video && Math.abs(video.currentTime - expected) < 0.5);
    },
    Math.max(0, thirdStartMs - 3000) / 1000,
    { timeout: 10_000 }
  );

  // Boundary nudge: the in-point walks to the previous sentence start,
  // the delta renders, and the adjusted bounds persist (D5 —
  // instrumentation columns, not client state).
  // Rank 1 opens at 0 after lead-in capture, so its in-prev nudge is
  // legitimately disabled — nudge the rank-2 card instead.
  await expect(
    momentItems.nth(1).getByTestId("moment-nudge-in-prev")
  ).toBeDisabled();
  await thirdCard.getByTestId("moment-nudge-in-prev").click();
  await expect(thirdCard.getByTestId("moment-nudge-delta")).toBeVisible();
  await expect
    .poll(
      async () => {
        const [adjusted] = await queryRows<{
          adjusted_end_ms: string | null;
          adjusted_start_ms: string | null;
        }>(
          "SELECT adjusted_start_ms, adjusted_end_ms FROM moment_candidate WHERE source_id = $1 AND rank = 2",
          [sourceId]
        );
        return adjusted?.adjusted_start_ms;
      },
      { timeout: 15_000 }
    )
    .not.toBeNull();
  const [adjustedRow] = await queryRows<{
    adjusted_end_ms: string;
    adjusted_start_ms: string;
    end_ms: string;
    start_ms: string;
  }>(
    "SELECT start_ms, end_ms, adjusted_start_ms, adjusted_end_ms FROM moment_candidate WHERE source_id = $1 AND rank = 2",
    [sourceId]
  );
  expect(Number(adjustedRow.adjusted_start_ms)).toBeLessThan(
    Number(adjustedRow.start_ms)
  );
  expect(Number(adjustedRow.adjusted_end_ms)).toBe(Number(adjustedRow.end_ms));
  const [boundsAudit] = await queryRows<{ entries: string }>(
    "SELECT COUNT(*) AS entries FROM audit_log WHERE action = 'moment.boundaries_adjusted'"
  );
  expect(Number(boundsAudit.entries)).toBeGreaterThanOrEqual(1);

  // Accept the top candidate; the readout and the row both record it.
  await momentItems.nth(0).getByTestId("moment-accept").click();
  await expect(page.getByTestId("moments-readout")).toHaveText(ONE_ACCEPTED, {
    timeout: 15_000,
  });
  const [acceptedRow] = await queryRows<{
    decided_by: string | null;
    status: string;
  }>(
    "SELECT status, decided_by FROM moment_candidate WHERE source_id = $1 AND rank = 0",
    [sourceId]
  );
  expect(acceptedRow.status).toBe("accepted");
  expect(acceptedRow.decided_by).not.toBeNull();

  // Reject through the reason menu — interactive UI, so the menu must
  // actually open (Base UI context crashes only fire on interaction).
  await thirdCard.getByTestId("moment-reject").click();
  const reasonItem = page
    .getByTestId("moment-reject-reason")
    .filter({ hasText: "Wrong boundaries" });
  await expect(reasonItem).toBeVisible({ timeout: 10_000 });
  await reasonItem.click();
  await expect(page.getByTestId("moments-readout")).toHaveText(
    ONE_ACCEPTED_ONE_REJECTED,
    { timeout: 15_000 }
  );
  const [rejectedRow] = await queryRows<{
    reject_reason: string | null;
    status: string;
  }>(
    "SELECT status, reject_reason FROM moment_candidate WHERE source_id = $1 AND rank = 2",
    [sourceId]
  );
  expect(rejectedRow.status).toBe("rejected");
  expect(rejectedRow.reject_reason).toBe("wrong_boundaries");
  const decisionAudits = await queryRows<{ action: string }>(
    "SELECT action FROM audit_log WHERE action IN ('moment.accepted', 'moment.rejected')"
  );
  expect(new Set(decisionAudits.map((entry) => entry.action))).toEqual(
    new Set(["moment.accepted", "moment.rejected"])
  );

  // The rejected row leaves the Top view and appears under the Rejected
  // toggle.
  await expect(momentItems).toHaveCount(2);
  await page.getByTestId("moments-view-rejected").click();
  await expect(momentItems).toHaveCount(1);
  await page.getByTestId("moments-view-top").click();
  await expect(momentItems).toHaveCount(2);

  // Re-running discovery would delete-and-replace the reviewed rows, so
  // with decisions on record it must refuse loudly.
  await page.getByTestId("rerun-discovery").click();
  await expect(page.getByTestId("rerun-discovery-error")).toHaveText(
    RERUN_REFUSAL,
    { timeout: 15_000 }
  );
  const [runAfterRefusal] = await queryRows<{ status: string }>(
    "SELECT status FROM moment_discovery_run WHERE source_id = $1",
    [sourceId]
  );
  expect(runAfterRefusal.status).toBe("ready");

  // ---- Segment clips (S6.5): the coverage lane ----
  // Planning is a button, never a chain: the missing state carries the
  // CTA, and the mock plan tiles the fixture as keep/drop/keep.
  await expect(page.getByTestId("segments-panel")).toBeVisible({
    timeout: 15_000,
  });
  await page.getByTestId("plan-segments").click();
  await expect
    .poll(
      async () => {
        const [planRun] = await queryRows<{ status: string }>(
          "SELECT status FROM segment_plan_run WHERE source_id = $1",
          [sourceId]
        );
        return planRun?.status ?? "missing";
      },
      { timeout: 60_000 }
    )
    .toBe("ready");

  const segItems = page.getByTestId("segment-item");
  await expect(segItems).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId("segment-drop")).toHaveCount(1);

  // The partition, proven from the database: chronological keep/drop/keep
  // rows tiling the fixture, grounded keeps, a reasoned drop, and the
  // reviewer's cold verdicts on keeps (mock flags the last keep).
  const segRows = await queryRows<{
    drop_reason: string | null;
    end_ms: string;
    grounded: boolean;
    idx: string;
    kind: string;
    review_fix: string | null;
    review_scores: unknown;
    start_ms: string;
  }>(
    "SELECT idx, kind, grounded, drop_reason, start_ms, end_ms, review_fix, review_scores FROM segment_clip WHERE source_id = $1 ORDER BY idx",
    [sourceId]
  );
  expect(segRows.map((segRow) => segRow.kind)).toEqual([
    "keep",
    "drop",
    "keep",
  ]);
  expect(Number(segRows[0]?.start_ms)).toBe(0);
  for (const [position, segRow] of segRows.entries()) {
    const following = segRows[position + 1];
    if (following) {
      expect(Number(following.start_ms)).toBeGreaterThanOrEqual(
        Number(segRow.end_ms)
      );
    }
  }
  const keeps = segRows.filter((segRow) => segRow.kind === "keep");
  expect(keeps.every((segRow) => segRow.grounded)).toBe(true);
  expect(keeps.every((segRow) => segRow.review_scores !== null)).toBe(true);
  expect(
    keeps.filter((segRow) => segRow.review_fix === "trim_end")
  ).toHaveLength(1);
  expect(segRows.find((segRow) => segRow.kind === "drop")?.drop_reason).toBe(
    "low_energy"
  );
  await expect(page.getByTestId("segment-review-flag")).toHaveCount(1);

  // Playback contract on the second chapter: play-from-in-point hits the
  // exact in, a card click applies the 3s pre-roll (clamped to 0 here).
  const secondKeep = segItems.nth(1);
  await secondKeep.getByTestId("segment-play-in").click();
  const keepStartMs = Number(
    await secondKeep.getByTestId("segment-card").getAttribute("data-start-ms")
  );
  expect(keepStartMs).toBeGreaterThan(0);
  await page.waitForFunction(
    (expected) => {
      const video = document.querySelector("video");
      return Boolean(video && Math.abs(video.currentTime - expected) < 0.5);
    },
    keepStartMs / 1000,
    { timeout: 10_000 }
  );

  // Nudge the second chapter's in-point back a sentence; the adjusted
  // bounds persist.
  await secondKeep.getByTestId("segment-nudge-in-prev").click();
  await expect(secondKeep.getByTestId("segment-nudge-delta")).toBeVisible();
  await expect
    .poll(
      async () => {
        const [adjusted] = await queryRows<{
          adjusted_start_ms: string | null;
        }>(
          "SELECT adjusted_start_ms FROM segment_clip WHERE source_id = $1 AND idx = 2",
          [sourceId]
        );
        return adjusted?.adjusted_start_ms;
      },
      { timeout: 15_000 }
    )
    .not.toBeNull();

  // Decisions: accept the first chapter, reject the second through the
  // reason menu (interactive UI — the menu must open).
  await segItems.nth(0).getByTestId("segment-accept").click();
  await expect(page.getByTestId("segments-readout")).toHaveText(ONE_ACCEPTED, {
    timeout: 15_000,
  });
  await secondKeep.getByTestId("segment-reject").click();
  const segReason = page
    .getByTestId("segment-reject-reason")
    .filter({ hasText: "Wrong boundaries" });
  await expect(segReason).toBeVisible({ timeout: 10_000 });
  await segReason.click();
  await expect
    .poll(
      async () => {
        const [rejectedSeg] = await queryRows<{ status: string }>(
          "SELECT status FROM segment_clip WHERE source_id = $1 AND idx = 2",
          [sourceId]
        );
        return rejectedSeg?.status;
      },
      { timeout: 15_000 }
    )
    .toBe("rejected");
  const [rejectedSeg] = await queryRows<{ reject_reason: string | null }>(
    "SELECT reject_reason FROM segment_clip WHERE source_id = $1 AND idx = 2",
    [sourceId]
  );
  expect(rejectedSeg.reject_reason).toBe("wrong_boundaries");

  // The model's drop is a proposal, not a veto: restore it.
  await page.getByTestId("segment-restore").click();
  await expect(segItems).toHaveCount(3, { timeout: 15_000 });
  const [restoredSeg] = await queryRows<{ kind: string; status: string }>(
    "SELECT kind, status FROM segment_clip WHERE source_id = $1 AND idx = 1",
    [sourceId]
  );
  expect(restoredSeg.kind).toBe("keep");
  expect(restoredSeg.status).toBe("proposed");

  // Re-planning must refuse while decisions exist.
  await page.getByTestId("rerun-segments").click();
  await expect(page.getByTestId("rerun-segments-error")).toHaveText(
    SEGMENT_RERUN_REFUSAL,
    { timeout: 15_000 }
  );

  // Park the player deep again — the Ask section below asserts its
  // citation click performs a real, observable seek.
  await allItems.last().click();
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

  // Failed-index recovery: a failed source_index must not leave a blank
  // spot where Ask lives (the S5 staging gap — a Voyage 429 was only
  // visible in the Trigger dashboard). The page-render backfill skips
  // failed rows by design, so the card's retry button is the recovery path.
  await queryRows(
    "UPDATE source_index SET status = 'failed', error = 'Voyage embeddings failed (429): rate limited' WHERE source_id = $1",
    [sourceId]
  );
  await page.reload();
  const indexCard = page.getByTestId("index-status-card");
  await expect(indexCard).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("index-error")).toHaveText(INDEX_FAILURE);
  await expect(askPanel).toHaveCount(0);
  await page.getByTestId("retry-index").click();
  await expect(askPanel).toBeVisible({ timeout: 60_000 });
  const [retriedIndex] = await queryRows<{ error: string | null }>(
    "SELECT error FROM source_index WHERE source_id = $1 AND status = 'ready'",
    [sourceId]
  );
  expect(retriedIndex.error).toBeNull();

  expect(errors, errors.join("\n")).toEqual([]);
});
