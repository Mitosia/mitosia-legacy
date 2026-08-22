import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import {
  type IngestStep,
  source,
  sourceArtifact,
  usageLedger,
} from "@/lib/db/schema";
import { withOrgScope } from "@/lib/db/tenant";
import { recordUsage } from "@/lib/ledger";
import { presignGetUrl, putFile, putJson } from "@/lib/storage";
import { sourcePrefixFromOriginalKey } from "@/lib/storage/keys";
import { inputArgs, parseProgressSeconds, runMediaCommand } from "./ffmpeg";
import {
  buildHlsArgs,
  buildIframePlaylistArgs,
  HLS_IFRAME_DIR,
  HLS_KEYFRAME_SECONDS,
  type MasterPlaylistEntry,
  planHlsLadder,
  renderMasterPlaylist,
} from "./hls";
import { sanitizeIngestError } from "./ingest-error";
import { generatePeaks } from "./peaks";
import { probeSource, type SourceProbe } from "./probe";
import { generatePoster, generateThumbnailStrip } from "./thumbs";
import {
  assertCoversDuration,
  probeDurationSeconds,
  sumPlaylistSeconds,
} from "./verify";

// The S2 ingest workflow: probe/validate → HLS proxy ladder → thumbnails →
// audio extract → waveform peaks → finalize (+ metering). Runs the same
// whether invoked by the Trigger.dev task or the in-process dev fallback.
// Every DB touch goes through withOrgScope, so a bad organizationId in the
// payload fails closed instead of crossing tenants.

const INGEST_ERROR_MAX_CHARS = 2000;
const UPLOAD_CONCURRENCY = 4;

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  json: "application/json",
  m3u8: "application/vnd.apple.mpegurl",
  m4a: "audio/mp4",
  ts: "video/mp2t",
};

export interface IngestPayload {
  organizationId: string;
  sourceId: string;
}

interface ArtifactUpload {
  kind: "hls_master" | "poster" | "thumbnail" | "audio" | "waveform";
  metadata?: Record<string, unknown>;
  // Required, not optional: an artifact row without a size is invisible to
  // per-artifact cost attribution, and the storage ledger entry is summed
  // from these — a missing one would silently under-meter the org.
  sizeBytes: number;
  storageKey: string;
}

function contentTypeFor(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      for (;;) {
        const item = queue.shift();
        if (item === undefined) {
          return;
        }
        // biome-ignore lint/performance/noAwaitInLoops: bounded worker pool
        await fn(item);
      }
    }
  );
  await Promise.all(workers);
}

async function walkFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // biome-ignore lint/performance/noAwaitInLoops: shallow tree, sequential is fine
      files.push(...(await walkFiles(join(dir, entry.name), relative)));
    } else {
      files.push(relative);
    }
  }
  return files;
}

// Uploads every file under localDir to storage under keyPrefix. Returns
// each uploaded file's size keyed by its path relative to localDir, so
// callers can attribute bytes to the artifact rows they create.
async function uploadDirectory(
  localDir: string,
  keyPrefix: string,
  onProgress?: (fraction: number) => void
): Promise<Map<string, number>> {
  const files = await walkFiles(localDir);

  // Sizes up front so progress can be reported in bytes rather than in files
  // completed: an HLS ladder is thousands of ~2s segments plus a handful of
  // playlists, and counting files would jump around relative to real work.
  const fileSizes = new Map<string, number>();
  let totalBytes = 0;
  for (const relative of files) {
    // biome-ignore lint/performance/noAwaitInLoops: local stat, and the total must be known before the first upload reports
    const { size } = await stat(join(localDir, relative));
    fileSizes.set(relative, size);
    totalBytes += size;
  }

  const sizes = new Map<string, number>();
  let uploadedBytes = 0;
  await mapWithConcurrency(files, UPLOAD_CONCURRENCY, async (relative) => {
    const filePath = join(localDir, relative);
    const size = fileSizes.get(relative) ?? 0;
    await putFile(
      `${keyPrefix}${relative}`,
      filePath,
      contentTypeFor(relative)
    );
    sizes.set(relative, size);
    uploadedBytes += size;
    if (totalBytes > 0) {
      onProgress?.(uploadedBytes / totalBytes);
    }
  });
  return sizes;
}

function sumSizes(sizes: Map<string, number>): number {
  let total = 0;
  for (const size of sizes.values()) {
    total += size;
  }
  return total;
}

async function setIngestStep(
  payload: IngestPayload,
  step: IngestStep
): Promise<void> {
  await withOrgScope(payload.organizationId, (tx) =>
    tx
      .update(source)
      .set({ ingestProgress: null, ingestStep: step })
      .where(eq(source.id, payload.sourceId))
  );
}

// How often progress reaches the database. ffmpeg reports about once a
// second; a 30-minute step does not need 1800 writes to look alive, and the
// project list only re-renders every few seconds anyway.
const PROGRESS_WRITE_INTERVAL_MS = 10_000;

// Throttled progress writer for a long step. Returns a function to hand to
// runMediaCommand, plus the flush the step awaits at the end so a write
// started mid-run cannot outlive it.
function throttledProgress(payload: IngestPayload) {
  let lastWrite = 0;
  let pending: Promise<void> = Promise.resolve();

  return {
    flush: () => pending,
    report: (fraction: number) => {
      const now = performance.now();
      if (now - lastWrite < PROGRESS_WRITE_INTERVAL_MS) {
        return;
      }
      lastWrite = now;

      // Clamped: ffmpeg can report a position slightly past the duration on
      // the final flush, and a badge reading 103% is worse than one at 100.
      const clamped = Math.min(1, Math.max(0, fraction));
      pending = pending
        .then(() =>
          withOrgScope(payload.organizationId, (tx) =>
            tx
              .update(source)
              .set({ ingestProgress: clamped })
              .where(eq(source.id, payload.sourceId))
          )
        )
        // A dropped progress write must never fail the ingest: it is a
        // cosmetic signal, and the work behind it is still fine.
        .then(
          () => undefined,
          () => undefined
        );
    },
  };
}

// Throttled progress writer for a long step. Returns a function to hand to
// runMediaCommand, plus the flush the step awaits at the end so a write
// started mid-run cannot outlive it.
function progressReporter(payload: IngestPayload, totalSeconds: number) {
  const writer = throttledProgress(payload);
  return {
    flush: writer.flush,
    onStdout: (chunk: Buffer) => {
      const seconds = parseProgressSeconds(chunk.toString());
      if (seconds === null || totalSeconds <= 0) {
        return;
      }
      writer.report(seconds / totalSeconds);
    },
  };
}

interface StartedIngest {
  attempt: number;
  storageKey: string;
}

// Claims the source for processing. Returns null when there is nothing to
// do (already processing elsewhere, still uploading, or gone).
async function claimSource(
  payload: IngestPayload
): Promise<StartedIngest | null> {
  return await withOrgScope(payload.organizationId, async (tx) => {
    const [row] = await tx
      .select({
        attempts: source.ingestAttempts,
        status: source.status,
        storageKey: source.storageKey,
      })
      .from(source)
      .where(eq(source.id, payload.sourceId))
      .limit(1);

    if (!row || row.status === "uploading" || row.status === "processing") {
      return null;
    }

    const attempt = row.attempts + 1;
    await tx
      .update(source)
      .set({
        ingestAttempts: attempt,
        ingestError: null,
        ingestStep: "probe",
        status: "processing",
      })
      .where(eq(source.id, payload.sourceId));

    // Re-runs overwrite the same storage keys; stale artifact rows would
    // collide on the storage-key unique index, so clear them up front.
    await tx
      .delete(sourceArtifact)
      .where(eq(sourceArtifact.sourceId, payload.sourceId));

    return { attempt, storageKey: row.storageKey };
  });
}

async function runHlsStep(
  inputUrl: string,
  probe: SourceProbe,
  workDir: string,
  keyPrefix: string,
  payload: IngestPayload
): Promise<ArtifactUpload[]> {
  const plan = planHlsLadder(probe);
  const hlsDir = join(workDir, "hls");
  await Promise.all(
    plan.map((variant) =>
      mkdir(join(hlsDir, variant.dirName), { recursive: true })
    )
  );

  const progress = progressReporter(payload, probe.durationSeconds);
  await runMediaCommand(
    "ffmpeg",
    buildHlsArgs(inputUrl, plan, Boolean(probe.audio), hlsDir),
    { onStdout: progress.onStdout }
  );
  await progress.flush();

  // Master playlist bandwidths come from measured variant sizes.
  const entries: MasterPlaylistEntry[] = [];
  const iframeEntries: MasterPlaylistEntry[] = [];
  for (const variant of plan) {
    const variantDir = join(hlsDir, variant.dirName);
    // Rung bytes are measured BEFORE the iframe rendition lands in the
    // same tree, so its bandwidth stays the bandwidth of what a player
    // streaming this rung actually fetches.
    // biome-ignore lint/performance/noAwaitInLoops: few variants, trivial cost
    const files = await walkFiles(variantDir);
    let variantBytes = 0;
    for (const file of files) {
      // biome-ignore lint/performance/noAwaitInLoops: few files, trivial cost
      variantBytes += (await stat(join(variantDir, file))).size;
    }

    // Verified before upload so a short ladder never reaches storage.
    const playlist = await readFile(join(variantDir, "index.m3u8"), "utf8");
    assertCoversDuration(
      `HLS variant ${variant.dirName}`,
      sumPlaylistSeconds(playlist),
      probe.durationSeconds
    );

    entries.push({
      bandwidth: (variantBytes * 8) / probe.durationSeconds,
      height: variant.height,
      path: `${variant.dirName}/index.m3u8`,
      width: variant.width,
    });

    if (variant.kind !== "video") {
      continue;
    }

    // I-frame-only rendition, derived from the just-verified local rung
    // (cheap: only keyframes are decoded, ~1 frame per 2s re-encoded).
    const iframeDir = join(variantDir, HLS_IFRAME_DIR);
    await mkdir(iframeDir, { recursive: true });
    await runMediaCommand(
      "ffmpeg",
      buildIframePlaylistArgs(
        join(variantDir, "index.m3u8"),
        variant,
        iframeDir
      )
    );

    // ffmpeg gives the last I-frame its frame duration rather than the
    // distance to end-of-stream, so full coverage sums to the media
    // duration minus at most one keyframe interval — that is the floor.
    const iframePlaylist = await readFile(
      join(iframeDir, "index.m3u8"),
      "utf8"
    );
    assertCoversDuration(
      `HLS I-frame playlist ${variant.dirName}`,
      sumPlaylistSeconds(iframePlaylist),
      Math.max(0, probe.durationSeconds - HLS_KEYFRAME_SECONDS)
    );

    const iframeFiles = await walkFiles(iframeDir);
    let iframeBytes = 0;
    for (const file of iframeFiles) {
      // biome-ignore lint/performance/noAwaitInLoops: few files, trivial cost
      iframeBytes += (await stat(join(iframeDir, file))).size;
    }
    iframeEntries.push({
      bandwidth: (iframeBytes * 8) / probe.durationSeconds,
      height: variant.height,
      path: `${variant.dirName}/${HLS_IFRAME_DIR}/index.m3u8`,
      width: variant.width,
    });
  }
  await writeFile(
    join(hlsDir, "master.m3u8"),
    renderMasterPlaylist(entries, iframeEntries)
  );

  // The ladder is built; pushing it to storage is the other half of this
  // stage and takes minutes at feature length. Reported as its own step so
  // the badge stops claiming "Preparing playback 100%" while thousands of
  // segments are still in flight.
  await setIngestStep(payload, "publish");
  const publishProgress = throttledProgress(payload);
  const sizes = await uploadDirectory(
    hlsDir,
    `${keyPrefix}hls/`,
    publishProgress.report
  );
  await publishProgress.flush();
  return [
    {
      kind: "hls_master",
      metadata: {
        variants: entries.map((entry) => ({
          bandwidth: Math.round(entry.bandwidth),
          height: entry.height,
          width: entry.width,
        })),
      },
      // The single hls_master row stands for the whole ladder: its size is
      // every playlist and segment under hls/, not just master.m3u8. That
      // is what keeps SUM(size_bytes) equal to the real stored footprint.
      sizeBytes: sumSizes(sizes),
      storageKey: `${keyPrefix}hls/master.m3u8`,
    },
  ];
}

async function runThumbnailStep(
  inputUrl: string,
  probe: SourceProbe,
  workDir: string,
  keyPrefix: string
): Promise<ArtifactUpload[]> {
  const thumbsDir = join(workDir, "thumbs");
  await mkdir(thumbsDir, { recursive: true });

  await generatePoster(
    inputUrl,
    probe.durationSeconds,
    join(workDir, "poster.jpg")
  );
  const { intervalSeconds } = await generateThumbnailStrip(
    inputUrl,
    probe.durationSeconds,
    thumbsDir
  );

  const posterBytes = (await stat(join(workDir, "poster.jpg"))).size;
  await putFile(
    `${keyPrefix}poster.jpg`,
    join(workDir, "poster.jpg"),
    "image/jpeg"
  );
  const stripSizes = await uploadDirectory(thumbsDir, `${keyPrefix}thumbs/`);

  const artifacts: ArtifactUpload[] = [
    {
      kind: "poster",
      sizeBytes: posterBytes,
      storageKey: `${keyPrefix}poster.jpg`,
    },
  ];
  const thumbFiles = [...stripSizes.keys()].sort((a, b) => a.localeCompare(b));
  artifacts.push(
    ...thumbFiles.map((file, index) => ({
      kind: "thumbnail" as const,
      metadata: { timeOffsetSeconds: index * intervalSeconds },
      sizeBytes: stripSizes.get(file) ?? 0,
      storageKey: `${keyPrefix}thumbs/${file}`,
    }))
  );

  return artifacts;
}

async function runAudioStep(
  inputUrl: string,
  workDir: string,
  keyPrefix: string,
  durationSeconds: number
): Promise<{ artifacts: ArtifactUpload[]; audioPath: string }> {
  const audioPath = join(workDir, "audio.m4a");
  await runMediaCommand("ffmpeg", [
    "-v",
    "error",
    "-y",
    ...inputArgs(inputUrl),
    "-vn",
    "-map",
    "0:a:0",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-movflags",
    "+faststart",
    audioPath,
  ]);

  // The audio extract feeds the waveform, and peaks.ts pads a short stream
  // with silence by design — so truncation here degrades into a plausible
  // looking waveform rather than an error. Check it explicitly.
  assertCoversDuration(
    "Audio extract",
    await probeDurationSeconds(audioPath),
    durationSeconds
  );

  const sizeBytes = (await stat(audioPath)).size;
  await putFile(`${keyPrefix}audio/audio.m4a`, audioPath, "audio/mp4");

  return {
    artifacts: [
      { kind: "audio", sizeBytes, storageKey: `${keyPrefix}audio/audio.m4a` },
    ],
    audioPath,
  };
}

async function runWaveformStep(
  audioPath: string,
  keyPrefix: string,
  mediaDurationSeconds: number
): Promise<ArtifactUpload[]> {
  const peaks = await generatePeaks(audioPath, mediaDurationSeconds);
  const key = `${keyPrefix}waveform/peaks.json`;
  const body = JSON.stringify(peaks);
  await putJson(key, peaks);
  return [
    {
      kind: "waveform",
      metadata: {
        length: peaks.length,
        samplesPerPixel: peaks.samples_per_pixel,
      },
      sizeBytes: Buffer.byteLength(body),
      storageKey: key,
    },
  ];
}

async function finalizeIngest(
  payload: IngestPayload,
  started: StartedIngest,
  probe: SourceProbe,
  artifacts: ArtifactUpload[],
  wallSeconds: number
): Promise<void> {
  await withOrgScope(payload.organizationId, async (tx) => {
    await tx.insert(sourceArtifact).values(
      artifacts.map((artifact) => ({
        kind: artifact.kind,
        metadata: artifact.metadata,
        mimeType: contentTypeFor(artifact.storageKey),
        organizationId: payload.organizationId,
        sizeBytes: artifact.sizeBytes,
        sourceId: payload.sourceId,
        storageKey: artifact.storageKey,
      }))
    );

    await tx
      .update(source)
      .set({
        durationSeconds: probe.durationSeconds,
        ingestProgress: null,
        ingestStep: null,
        metadata: probe as unknown as Record<string, unknown>,
        status: "ready",
      })
      .where(eq(source.id, payload.sourceId));

    // Processing minutes are media minutes (the cost driver), wall clock
    // kept alongside for observability.
    await recordUsage(tx, {
      correlationId: `processing:${payload.sourceId}:${started.attempt}`,
      entryType: "processing_minutes",
      metadata: { wallSeconds: Math.round(wallSeconds) },
      organizationId: payload.organizationId,
      quantity: probe.durationSeconds / 60,
      sourceId: payload.sourceId,
      unit: "minutes",
    });

    // The metered quantity is read back from the artifact rows just
    // written, not tallied alongside them: per-artifact attribution and
    // the ledger are then the same number by construction, and cannot
    // drift. claimSource() clears prior rows, so this is the current
    // footprint of the whole source.
    const [current] = await tx
      .select({
        total: sql<number>`COALESCE(SUM(${sourceArtifact.sizeBytes}), 0)::double precision`,
      })
      .from(sourceArtifact)
      .where(eq(sourceArtifact.sourceId, payload.sourceId));

    // Artifact storage is metered as a delta against what previous runs
    // already recorded — re-ingest overwrites objects in place, so only
    // net-new bytes hit the ledger.
    const [previous] = await tx
      .select({
        total: sql<number>`COALESCE(SUM(${usageLedger.quantity}), 0)`,
      })
      .from(usageLedger)
      .where(
        sql`${usageLedger.sourceId} = ${payload.sourceId}
          AND ${usageLedger.entryType} = 'storage_bytes'
          AND ${usageLedger.metadata}->>'category' = 'artifacts'`
      );
    const delta = (current?.total ?? 0) - (previous?.total ?? 0);
    if (delta !== 0) {
      await recordUsage(tx, {
        correlationId: `storage:artifacts:${payload.sourceId}:${started.attempt}`,
        entryType: "storage_bytes",
        metadata: { category: "artifacts" },
        organizationId: payload.organizationId,
        quantity: delta,
        sourceId: payload.sourceId,
        unit: "bytes",
      });
    }
  });
}

async function recordFailure(
  payload: IngestPayload,
  error: unknown
): Promise<void> {
  const message =
    error instanceof Error ? error.message : "Unknown ingest failure";
  await withOrgScope(payload.organizationId, (tx) =>
    tx
      .update(source)
      .set({
        ingestError: sanitizeIngestError(message).slice(
          0,
          INGEST_ERROR_MAX_CHARS
        ),
        status: "failed",
      })
      .where(eq(source.id, payload.sourceId))
  );
}

export async function runIngestPipeline(payload: IngestPayload): Promise<void> {
  const started = await claimSource(payload);
  if (!started) {
    return;
  }

  const startedAt = Date.now();
  const workDir = await mkdtemp(join(tmpdir(), "mitosia-ingest-"));

  try {
    const keyPrefix = sourcePrefixFromOriginalKey(started.storageKey);
    const inputUrl = await presignGetUrl(started.storageKey);

    const probe = await probeSource(inputUrl);

    const artifacts: ArtifactUpload[] = [];

    await setIngestStep(payload, "hls");
    artifacts.push(
      ...(await runHlsStep(inputUrl, probe, workDir, keyPrefix, payload))
    );

    if (probe.video) {
      await setIngestStep(payload, "thumbnails");
      artifacts.push(
        ...(await runThumbnailStep(inputUrl, probe, workDir, keyPrefix))
      );
    }

    if (probe.audio) {
      await setIngestStep(payload, "audio");
      const audio = await runAudioStep(
        inputUrl,
        workDir,
        keyPrefix,
        probe.durationSeconds
      );
      artifacts.push(...audio.artifacts);

      await setIngestStep(payload, "waveform");
      artifacts.push(
        ...(await runWaveformStep(
          audio.audioPath,
          keyPrefix,
          probe.durationSeconds
        ))
      );
    }

    await setIngestStep(payload, "finalize");
    await finalizeIngest(
      payload,
      started,
      probe,
      artifacts,
      (Date.now() - startedAt) / 1000
    );

    // Transcription is a follow-on job, not an eighth step: "ready" keeps
    // meaning playable, and a provider outage cannot fail an ingest that
    // already succeeded. Enqueued after finalize so the audio artifact row
    // it reads is committed. Errors are the job's own to record — a failed
    // enqueue must not mark a finished ingest failed — hence the catch.
    if (probe.audio) {
      try {
        const { enqueueTranscription } = await import(
          "@/lib/transcription/enqueue"
        );
        await enqueueTranscription(payload);
      } catch (error) {
        console.error(
          `[ingest] transcription enqueue failed for ${payload.sourceId}:`,
          error
        );
      }
    }
  } catch (error) {
    await recordFailure(payload, error);
    throw error;
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
}
