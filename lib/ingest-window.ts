// How long an ingest may go without touching its source row before the
// reaper calls it dead.
//
// This is *silence*, not total runtime — a two-hour transcode is fine, an
// ingest that writes nothing for half an hour is not. The number is set by
// the longest gap a *healthy* pipeline can leave, which is not the ladder:
// the ladder reports progress every 10s throughout (and, since the publish
// step, through its upload too). The silent stretches are the steps that
// report nothing at all — thumbnails, audio, waveform, finalize — each of
// which only writes when it starts. Those scale with source duration, so
// the window has to clear the worst of them on the longest source anyone
// might upload, with room to spare.
//
// Erring long is the cheap direction. Reaping late leaves a wrong badge for
// a few extra minutes; reaping early kills a healthy ingest and, worse,
// makes the row claimable again while the original is still writing to it.
export const INGEST_STALL_TTL_MINUTES = 30;
