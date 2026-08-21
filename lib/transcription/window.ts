// How long a transcript may sit at "processing" with no row writes before
// the reaper marks it failed. Kept in its own module (like
// lib/ingest-window.ts) so the reaper, tests, and UI copy share one number.
//
// Sizing: Deepgram prerecorded turns a two-hour file around in minutes and
// the whole run makes no intermediate row writes, so unlike ingest there is
// no long silent-but-healthy phase to protect. 15 minutes is several times
// the worst observed turnaround; erring long is the cheap direction — the
// same claim-race logic as ingest applies (reaping early makes the row
// claimable while the original may still be writing).
export const TRANSCRIPTION_STALL_TTL_MINUTES = 15;
