// Stall window for the analysis reaper (the lib/ingest-window.ts pattern).
// Two structured-output calls over ~30k tokens finish in tens of seconds
// normally; 20 minutes of row silence means the process died.
export const ANALYSIS_STALL_TTL_MINUTES = 20;
