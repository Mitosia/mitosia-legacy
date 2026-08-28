import { runMediaCommand } from "./ffmpeg";

// Shot-change detection (docs/clip-cut-architecture.md §7): a deterministic
// ffmpeg scene-score pass over the just-built LOCAL proxy rung, emitting
// every candidate cut above a low floor. Thresholding happens in code
// (SHOT_SCORE_THRESHOLD, retunable without re-decoding); the raw scores
// persist so the threshold can move later. Hard cuts — multicam switches,
// the dominant transition in podcast masters — are exactly what this
// detects reliably; a locked single-camera shot correctly yields ~no
// events, which downstream reads as "no visual constraint on cuts".
//
// Runs on the LOCAL rung file inside the ingest pipeline (the
// buildIframePlaylistArgs re-read pattern) — never a bare remote -i url.

// Floor for EMITTING a score row; the decision threshold applied by
// consumers. 0.3-0.4 is the canonical hard-cut range for select's scene
// score; storing everything ≥0.1 keeps the threshold retunable.
const SHOT_SCORE_FLOOR = 0.1;
export const SHOT_SCORE_THRESHOLD = 0.3;

export interface ShotEvent {
  score: number;
  timeMs: number;
}

export interface ShotsArtifact {
  events: ShotEvent[];
  floor: number;
  version: 1;
}

// The movie filter takes the path inline; commas inside the select
// expression are escaped for the filtergraph parser.
export function buildShotDetectArgs(localPlaylistPath: string): string[] {
  return [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `movie=${localPlaylistPath},select=gt(scene\\,${SHOT_SCORE_FLOOR})`,
    "-show_entries",
    "frame=pts_time",
    "-show_entries",
    "frame_tags=lavfi.scene_score",
    "-of",
    "csv=p=0",
  ];
}

// One "pts_time,score" line per candidate cut.
export function parseShotCsv(stdout: string): ShotEvent[] {
  const events: ShotEvent[] = [];
  for (const line of stdout.split("\n")) {
    const [time, score] = line.trim().split(",");
    const timeSeconds = Number(time);
    const scoreValue = Number(score);
    if (
      time &&
      Number.isFinite(timeSeconds) &&
      Number.isFinite(scoreValue) &&
      scoreValue >= SHOT_SCORE_FLOOR
    ) {
      events.push({
        score: scoreValue,
        timeMs: Math.round(timeSeconds * 1000),
      });
    }
  }
  return events;
}

export async function detectShots(
  localPlaylistPath: string
): Promise<ShotsArtifact> {
  const { stdout } = await runMediaCommand(
    "ffprobe",
    buildShotDetectArgs(localPlaylistPath)
  );
  return { events: parseShotCsv(stdout), floor: SHOT_SCORE_FLOOR, version: 1 };
}

// Consumers snap to CONFIDENT cuts only.
export function shotTimesAboveThreshold(
  artifact: Pick<ShotsArtifact, "events">,
  threshold: number = SHOT_SCORE_THRESHOLD
): number[] {
  return artifact.events
    .filter((event) => event.score >= threshold)
    .map((event) => event.timeMs);
}
