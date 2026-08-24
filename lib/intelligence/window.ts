// Stall window for the source-index reaper (the lib/ingest-window.ts
// pattern). Chunking is instant and embedding a 2.5h source is a handful of
// batched HTTP calls — tens of seconds end to end. Ten minutes of row
// silence means the process died.
export const INDEX_STALL_TTL_MINUTES = 10;
