// Stall window for the source-index reaper (the lib/ingest-window.ts
// pattern). Chunking is instant and embedding a 2.5h source is a handful of
// batched HTTP calls — tens of seconds end to end. Ten minutes of row
// silence means the process died.
export const INDEX_STALL_TTL_MINUTES = 10;

// Extraction runs four structured-output calls (three sequential-ish over a
// cached prefix); minutes of work like analysis — same window as its reaper.
export const EXTRACTION_STALL_TTL_MINUTES = 20;

// Discovery is ONE structured-output call over the same prefix plus pure
// post-processing — comfortably inside the extraction envelope.
export const DISCOVERY_STALL_TTL_MINUTES = 20;
