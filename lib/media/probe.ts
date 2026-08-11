import { z } from "zod";
import { inputArgs, runMediaCommand } from "./ffmpeg";

// Probe + validation gate: nothing enters the pipeline that ffprobe cannot
// fully describe. The parsed result is stored on the source row as metadata
// and drives ladder planning (dimensions, audio presence).

export class ProbeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProbeError";
  }
}

const ffprobeStreamSchema = z.object({
  avg_frame_rate: z.string().optional(),
  channels: z.number().optional(),
  codec_name: z.string().optional(),
  codec_type: z.string().optional(),
  duration: z.coerce.number().optional(),
  height: z.number().optional(),
  r_frame_rate: z.string().optional(),
  sample_rate: z.coerce.number().optional(),
  width: z.number().optional(),
});

const ffprobeOutputSchema = z.object({
  format: z
    .object({
      bit_rate: z.coerce.number().optional(),
      duration: z.coerce.number().optional(),
      format_name: z.string().optional(),
      size: z.coerce.number().optional(),
    })
    .optional(),
  streams: z.array(ffprobeStreamSchema).default([]),
});

export interface SourceProbe {
  audio?: { channels: number; codec: string; sampleRate: number };
  bitrate?: number;
  container?: string;
  durationSeconds: number;
  video?: {
    codec: string;
    fps: number;
    height: number;
    // r_frame_rate ≠ avg_frame_rate is the classic variable-frame-rate
    // smell (screen recordings, phone footage) — recorded so downstream
    // editing (S8) knows to distrust frame math on this source.
    vfr: boolean;
    width: number;
  };
}

function parseFrameRate(raw: string | undefined): number {
  if (!raw) {
    return 0;
  }
  const [numerator, denominator] = raw.split("/").map(Number);
  if (!(numerator && denominator)) {
    return 0;
  }
  return numerator / denominator;
}

export function parseFfprobeJson(raw: string): SourceProbe {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new ProbeError("ffprobe returned unreadable output", { cause });
  }

  const parsed = ffprobeOutputSchema.safeParse(json);
  if (!parsed.success) {
    throw new ProbeError("ffprobe output did not match the expected shape");
  }

  const videoStream = parsed.data.streams.find(
    (stream) => stream.codec_type === "video" && stream.codec_name !== "mjpeg"
  );
  const audioStream = parsed.data.streams.find(
    (stream) => stream.codec_type === "audio"
  );

  if (!(videoStream || audioStream)) {
    throw new ProbeError(
      "No decodable audio or video stream found — the file may be corrupt"
    );
  }

  const durationSeconds =
    parsed.data.format?.duration ??
    videoStream?.duration ??
    audioStream?.duration ??
    0;

  if (durationSeconds <= 0) {
    throw new ProbeError("Could not determine media duration");
  }

  const probe: SourceProbe = {
    bitrate: parsed.data.format?.bit_rate,
    container: parsed.data.format?.format_name,
    durationSeconds,
  };

  if (videoStream?.width && videoStream.height && videoStream.codec_name) {
    const realRate = parseFrameRate(videoStream.r_frame_rate);
    const avgRate = parseFrameRate(videoStream.avg_frame_rate);
    probe.video = {
      codec: videoStream.codec_name,
      fps: avgRate > 0 ? avgRate : realRate,
      height: videoStream.height,
      vfr: realRate > 0 && avgRate > 0 && Math.abs(realRate - avgRate) > 0.01,
      width: videoStream.width,
    };
  }

  if (audioStream?.codec_name) {
    probe.audio = {
      channels: audioStream.channels ?? 1,
      codec: audioStream.codec_name,
      sampleRate: audioStream.sample_rate ?? 0,
    };
  }

  return probe;
}

export async function probeSource(inputUrl: string): Promise<SourceProbe> {
  const { stdout } = await runMediaCommand("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    ...inputArgs(inputUrl),
  ]);
  return parseFfprobeJson(stdout);
}
