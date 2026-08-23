import { serializeSrt } from "@remotion/captions";
import { speakerDisplayName } from "./paragraphs";
import type { TranscriptWord } from "./types";

// Word array → subtitle cues → SRT/VTT. The segmentation is ours because no
// library does speaker-aware cue breaks (evaluated 2026-08-22; see
// AGENTS.md §Transcription); the SRT serialization rides @remotion/captions
// and the VTT writer is trivial. Starting numbers follow stable-ts/WhisperX
// practice: sentence enders, then silence gaps, then size/duration caps.

const MAX_CUE_CHARS = 70;
const MAX_CUE_MS = 7000;
const SILENCE_BREAK_MS = 750;
const SENTENCE_END = /[.!?…]["')\]]?$/;

export interface TranscriptCue {
  endMs: number;
  speaker: string | null;
  startMs: number;
  text: string;
}

function startsNewCue(
  current: TranscriptCue | null,
  lastWord: TranscriptWord | null,
  word: TranscriptWord
): boolean {
  if (!(current && lastWord)) {
    return true;
  }
  return (
    // Speaker turns always break — the rule no off-the-shelf tool has
    word.speaker !== lastWord.speaker ||
    SENTENCE_END.test(lastWord.text) ||
    word.startMs - lastWord.endMs > SILENCE_BREAK_MS ||
    current.text.length + word.text.length + 1 > MAX_CUE_CHARS ||
    word.endMs - current.startMs > MAX_CUE_MS
  );
}

export function buildCues(words: readonly TranscriptWord[]): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  let current: TranscriptCue | null = null;
  let lastWord: TranscriptWord | null = null;

  for (const word of words) {
    if (startsNewCue(current, lastWord, word)) {
      current = {
        endMs: word.endMs,
        speaker: word.speaker,
        startMs: word.startMs,
        text: word.text,
      };
      cues.push(current);
    } else if (current) {
      current.text += ` ${word.text}`;
      current.endMs = word.endMs;
    }
    lastWord = word;
  }
  return cues;
}

// SRT: speaker prefix only when the speaker changes between cues (the
// Deepgram captions convention — repeating it every cue is noise).
export function cuesToSrt(
  cues: readonly TranscriptCue[],
  speakerLabels: Record<string, string> | null
): string {
  let lastSpeaker: string | null | undefined;
  const lines = cues.map((cue) => {
    const prefix =
      cue.speaker !== lastSpeaker && cue.speaker !== null
        ? `[${speakerDisplayName(cue.speaker, speakerLabels)}] `
        : "";
    lastSpeaker = cue.speaker;
    return [
      {
        confidence: null,
        endMs: cue.endMs,
        startMs: cue.startMs,
        text: `${prefix}${cue.text}`,
        timestampMs: null,
      },
    ];
  });
  return serializeSrt({ lines });
}

function vttTimestamp(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

// VTT: <v Name> voice tags on every cue (the format's own speaker
// mechanism; players style/toggle by voice).
export function cuesToVtt(
  cues: readonly TranscriptCue[],
  speakerLabels: Record<string, string> | null
): string {
  const blocks = cues.map((cue) => {
    const voice =
      cue.speaker === null
        ? cue.text
        : `<v ${speakerDisplayName(cue.speaker, speakerLabels)}>${cue.text}`;
    return `${vttTimestamp(cue.startMs)} --> ${vttTimestamp(cue.endMs)}\n${voice}`;
  });
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}
