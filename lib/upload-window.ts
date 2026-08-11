// How long a half-finished upload stays resumable. Shared deliberately by
// both halves of the resume state so they go stale together: the browser
// (Golden Retriever's localStorage/IndexedDB expiry, which holds the file
// list, the multipart upload id and our source id) and the server (the
// stale-upload reaper, which aborts the storage-side multipart upload).
// Well inside R2's 7-day "Default Multipart Abort Rule", which is the
// backstop for anything the reaper never sees.
//
// This is *idle* time, not total upload time: every part signature
// refreshes the source row's updated_at, so a slow 20 GB upload never
// trips it and an abandoned one always does.
export const UPLOAD_IDLE_TTL_HOURS = 24;
export const UPLOAD_IDLE_TTL_MS = UPLOAD_IDLE_TTL_HOURS * 60 * 60 * 1000;
