import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
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
import { runMediaCommand } from "./ffmpeg";
import {
  buildHlsArgs,
  type MasterPlaylistEntry,
  planHlsLadder,
  renderMasterPlaylist,
} from "./hls";
import { sanitizeIngestError } from "./ingest-error";
import { generatePeaks } from "./peaks";
import { probeSource, type SourceProbe } from "./probe";
import { generatePoster, generateThumbnailStrip } from "./thumbs";

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

// Uploads every file under localDir to storage under keyPrefix.
// Returns total bytes uploaded.
async function uploadDirectory(
  localDir: string,
  keyPrefix: string
): Promise<number> {
  const files = await walkFiles(localDir);
  let totalBytes = 0;
  await mapWithConcurrency(files, UPLOAD_CONCURRENCY, async (relative) => {
    const filePath = join(localDir, relative);
    const { size } = await stat(filePath);
    totalBytes += size;
    await putFile(
      `${keyPrefix}${relative}`,
      filePath,
      contentTypeFor(relative)
    );
  });
  return totalBytes;
}

async function setIngestStep(
  payload: IngestPayload,
  step: IngestStep
): Promise<void> {
  await withOrgScope(payload.organizationId, (tx) =>
    tx
      .update(source)
      .set({ ingestStep: step })
      .where(eq(source.id, payload.sourceId))
  );
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
  keyPrefix: string
): Promise<{ artifacts: ArtifactUpload[]; bytes: number }> {
  const plan = planHlsLadder(probe);
  const hlsDir = join(workDir, "hls");
  await Promise.all(
    plan.map((variant) =>
      mkdir(join(hlsDir, variant.dirName), { recursive: true })
    )
  );

  await runMediaCommand(
    "ffmpeg",
    buildHlsArgs(inputUrl, plan, Boolean(probe.audio), hlsDir)
  );

  // Master playlist bandwidths come from measured variant sizes.
  const entries: MasterPlaylistEntry[] = [];
  for (const variant of plan) {
    const variantDir = join(hlsDir, variant.dirName);
    // biome-ignore lint/performance/noAwaitInLoops: few variants, trivial cost
    const files = await walkFiles(variantDir);
    let variantBytes = 0;
    for (const file of files) {
      // biome-ignore lint/performance/noAwaitInLoops: few files, trivial cost
      variantBytes += (await stat(join(variantDir, file))).size;
    }
    entries.push({
      bandwidth: (variantBytes * 8) / probe.durationSeconds,
      height: variant.height,
      path: `${variant.dirName}/index.m3u8`,
      width: variant.width,
    });
  }
  await writeFile(join(hlsDir, "master.m3u8"), renderMasterPlaylist(entries));

  const bytes = await uploadDirectory(hlsDir, `${keyPrefix}hls/`);
  return {
    artifacts: [
      {
        kind: "hls_master",
        metadata: {
          variants: entries.map((entry) => ({
            bandwidth: Math.round(entry.bandwidth),
            height: entry.height,
            width: entry.width,
          })),
        },
        storageKey: `${keyPrefix}hls/master.m3u8`,
      },
    ],
    bytes,
  };
}

async function runThumbnailStep(
  inputUrl: string,
  probe: SourceProbe,
  workDir: string,
  keyPrefix: string
): Promise<{ artifacts: ArtifactUpload[]; bytes: number }> {
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
  const stripBytes = await uploadDirectory(thumbsDir, `${keyPrefix}thumbs/`);

  const artifacts: ArtifactUpload[] = [
    { kind: "poster", storageKey: `${keyPrefix}poster.jpg` },
  ];
  const thumbFiles = (await walkFiles(thumbsDir)).sort((a, b) =>
    a.localeCompare(b)
  );
  artifacts.push(
    ...thumbFiles.map((file, index) => ({
      kind: "thumbnail" as const,
      metadata: { timeOffsetSeconds: index * intervalSeconds },
      storageKey: `${keyPrefix}thumbs/${file}`,
    }))
  );

  return { artifacts, bytes: posterBytes + stripBytes };
}

async function runAudioStep(
  inputUrl: string,
  workDir: string,
  keyPrefix: string
): Promise<{ artifacts: ArtifactUpload[]; audioPath: string; bytes: number }> {
  const audioPath = join(workDir, "audio.m4a");
  await runMediaCommand("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    inputUrl,
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

  const bytes = (await stat(audioPath)).size;
  await putFile(`${keyPrefix}audio/audio.m4a`, audioPath, "audio/mp4");

  return {
    artifacts: [{ kind: "audio", storageKey: `${keyPrefix}audio/audio.m4a` }],
    audioPath,
    bytes,
  };
}

async function runWaveformStep(
  audioPath: string,
  keyPrefix: string
): Promise<{ artifacts: ArtifactUpload[]; bytes: number }> {
  const peaks = await generatePeaks(audioPath);
  const key = `${keyPrefix}waveform/peaks.json`;
  const body = JSON.stringify(peaks);
  await putJson(key, peaks);
  return {
    artifacts: [
      {
        kind: "waveform",
        metadata: {
          length: peaks.length,
          samplesPerPixel: peaks.samples_per_pixel,
        },
        storageKey: key,
      },
    ],
    bytes: Buffer.byteLength(body),
  };
}

async function finalizeIngest(
  payload: IngestPayload,
  started: StartedIngest,
  probe: SourceProbe,
  artifacts: ArtifactUpload[],
  artifactBytes: number,
  wallSeconds: number
): Promise<void> {
  await withOrgScope(payload.organizationId, async (tx) => {
    await tx.insert(sourceArtifact).values(
      artifacts.map((artifact) => ({
        kind: artifact.kind,
        metadata: artifact.metadata,
        mimeType: contentTypeFor(artifact.storageKey),
        organizationId: payload.organizationId,
        sourceId: payload.sourceId,
        storageKey: artifact.storageKey,
      }))
    );

    await tx
      .update(source)
      .set({
        durationSeconds: probe.durationSeconds,
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
    const delta = artifactBytes - (previous?.total ?? 0);
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
    let artifactBytes = 0;

    await setIngestStep(payload, "hls");
    const hls = await runHlsStep(inputUrl, probe, workDir, keyPrefix);
    artifacts.push(...hls.artifacts);
    artifactBytes += hls.bytes;

    if (probe.video) {
      await setIngestStep(payload, "thumbnails");
      const thumbs = await runThumbnailStep(
        inputUrl,
        probe,
        workDir,
        keyPrefix
      );
      artifacts.push(...thumbs.artifacts);
      artifactBytes += thumbs.bytes;
    }

    if (probe.audio) {
      await setIngestStep(payload, "audio");
      const audio = await runAudioStep(inputUrl, workDir, keyPrefix);
      artifacts.push(...audio.artifacts);
      artifactBytes += audio.bytes;

      await setIngestStep(payload, "waveform");
      const waveform = await runWaveformStep(audio.audioPath, keyPrefix);
      artifacts.push(...waveform.artifacts);
      artifactBytes += waveform.bytes;
    }

    await setIngestStep(payload, "finalize");
    await finalizeIngest(
      payload,
      started,
      probe,
      artifacts,
      artifactBytes,
      (Date.now() - startedAt) / 1000
    );
  } catch (error) {
    await recordFailure(payload, error);
    throw error;
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
}
