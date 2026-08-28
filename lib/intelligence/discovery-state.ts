import { sql } from "drizzle-orm";
import { momentCandidate, momentDiscoveryRun } from "@/lib/db/schema";

// A failed refresh is not the same as a failed first run. Candidate rows are
// the last successfully committed result and stay valid until another result
// replaces them, so every terminal failure path restores that usable `ready`
// state when such rows still exist. The error remains on the run for the UI.
export const terminalDiscoveryFailureStatus = sql<"failed" | "ready">`
  CASE WHEN EXISTS (
    SELECT 1 FROM ${momentCandidate}
    WHERE ${momentCandidate.runId} = ${momentDiscoveryRun.id}
  ) THEN 'ready' ELSE 'failed' END
`;
