import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createAccountWithOrg } from "./support/auth";
import { queryRows } from "./support/db";

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
const SETTINGS_BUTTON = /settings/i;
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

// Names carry a per-attempt suffix: a retry that reuses fixed names can
// otherwise click into the previous attempt's identically-named hierarchy
// (and with RLS accidentally disabled, even cross-tenant — see PR #16).
async function createHierarchy(
  page: import("@playwright/test").Page,
  run: string
) {
  const client = `E2E Media Client ${run}`;
  const brand = `E2E Brand ${run}`;
  const campaign = `E2E Campaign ${run}`;
  const project = `E2E Project ${run}`;

  await page.goto("/clients");
  await page.getByLabel("New client").fill(client);
  await page.getByRole("button", { name: "Add client" }).click();
  await page.getByRole("link", { name: client }).click();

  await page.getByLabel("New brand").fill(brand);
  await page.getByRole("button", { name: "Add brand" }).click();
  await page.getByRole("link", { name: brand }).click();

  await page.getByLabel("New campaign").fill(campaign);
  await page.getByRole("button", { name: "Add campaign" }).click();
  await page.getByRole("link", { name: campaign }).click();

  await page.getByLabel("New project").fill(project);
  await page.getByRole("button", { name: "Add project" }).click();
  await page.getByRole("link", { name: project }).click();
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
  await createHierarchy(page, Date.now().toString(36));

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
  // Generous budget: on cold CI runners the source route compiles on first
  // hit, and the click can already race a RefreshPoller re-render.
  await page.getByRole("link", { name: "tiny-source" }).click();
  await page.waitForURL(SOURCE_PAGE_URL, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "tiny-source" })).toBeVisible({
    timeout: 15_000,
  });

  // Every artifact must carry its size. This has no UI surface: size_bytes
  // was NULL on every artifact row the pipeline ever wrote and nothing
  // broke — it only cost per-artifact attribution, which billing needs.
  const sourceId = new URL(page.url()).pathname.split("/").pop() ?? "";
  const artifacts = await queryRows<{
    kind: string;
    size_bytes: string | null;
  }>("SELECT kind, size_bytes FROM source_artifact WHERE source_id = $1", [
    sourceId,
  ]);
  expect(artifacts.length).toBeGreaterThan(0);
  expect(
    artifacts.filter((artifact) => Number(artifact.size_bytes ?? 0) <= 0),
    "every artifact row needs a positive size_bytes"
  ).toEqual([]);
  // The fixture has both video and audio, so the pipeline emits all five.
  expect(
    [...new Set(artifacts.map((artifact) => artifact.kind))].sort()
  ).toEqual(["audio", "hls_master", "poster", "thumbnail", "waveform"]);

  // …and the metered storage figure is those same bytes. The ledger entry
  // is derived from these rows, so any divergence means the derivation
  // grew a second source of truth again.
  const [totals] = await queryRows<{ artifacts: string; ledger: string }>(
    `SELECT
       (SELECT COALESCE(SUM(size_bytes), 0) FROM source_artifact
          WHERE source_id = $1) AS artifacts,
       (SELECT COALESCE(SUM(quantity), 0) FROM usage_ledger
          WHERE source_id = $1
            AND entry_type = 'storage_bytes'
            AND metadata->>'category' = 'artifacts') AS ledger`,
    [sourceId]
  );
  expect(Number(totals.ledger)).toBe(Number(totals.artifacts));

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

  // The strip must hold PIXELS before any interaction — canvas visibility
  // alone let a fully transparent waveform ship: peaks.js froze the
  // played/unplayed split with the init-time duration (NaN before hls
  // metadata), so nothing could ever paint, in dev and prod builds alike.
  // The waveform layer is the first canvas peaks adds to the stage.
  await page
    .waitForFunction(
      () => {
        const canvas = document.querySelector(
          '[data-testid="waveform-overview"] canvas'
        ) as HTMLCanvasElement | null;
        if (!canvas || canvas.width === 0) {
          return false;
        }
        const pixels = canvas
          .getContext("2d")
          ?.getImageData(0, 0, canvas.width, canvas.height).data;
        if (!pixels) {
          return false;
        }
        let nonblank = 0;
        for (let i = 3; i < pixels.length; i += 41) {
          if (pixels[i] > 0) {
            nonblank += 1;
          }
        }
        return nonblank > 50;
      },
      undefined,
      { timeout: 15_000 }
    )
    .catch(() => {
      throw new Error("waveform overview never painted any pixels");
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

  // After the seek, both halves of the played/unplayed split render:
  // played (indigo #6366f1) behind the playhead, unplayed (slate #94a3b8)
  // ahead of it. If the split captured a bogus duration, one half vanishes.
  const split = await page.evaluate(() => {
    const canvas = document.querySelector(
      '[data-testid="waveform-overview"] canvas'
    ) as HTMLCanvasElement;
    const pixels = canvas
      .getContext("2d")
      ?.getImageData(0, 0, canvas.width, canvas.height).data;
    const count = { indigo: 0, slate: 0 };
    if (!pixels) {
      return count;
    }
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] < 200) {
        continue;
      }
      const [r, , b] = [pixels[i - 3], pixels[i - 2], pixels[i - 1]];
      if (b > 200 && r < 130) {
        count.indigo += 1;
      } else if (r > 130 && r < 170 && b < 200) {
        count.slate += 1;
      }
    }
    return count;
  });
  expect(split.indigo, "played region should render").toBeGreaterThan(0);
  expect(split.slate, "unplayed region should render").toBeGreaterThan(0);

  // The Video.js skin's settings menu is openable interactive UI, so it
  // gets exercised here (project rule: every menu opens under e2e). Hover
  // first — the control bar auto-hides without pointer activity.
  await page.locator("video").hover();
  await page.getByRole("button", { name: SETTINGS_BUTTON }).click();
  await expect(page.getByRole("menu")).toBeVisible({ timeout: 5000 });

  expect(errors, errors.join("\n")).toEqual([]);
});
