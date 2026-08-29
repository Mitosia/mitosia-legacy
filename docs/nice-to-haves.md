# Nice-to-have backlog

**Status:** Deferred work outside the active sprint plan  
**Priority rule:** Completing Mitosia's core source-to-asset workflow comes first.

This document keeps worthwhile product improvements from being lost without
quietly expanding current scope. An item here is not authorized sprint work.
Promote one only through an explicit priority decision and a corresponding
update to [sprint-plan.md](sprint-plan.md).

## Live generation progress for Moments and Segments

**Status:** Deferred  
**Recorded:** 2026-08-29  
**Priority:** Nice to have; revisit after the core features

### Problem worth retaining

While moment discovery or segment planning runs, the review panel currently
shows one static sentence and refreshes the source page periodically. The work
is durable, but the interface does not reveal which editorial pass is active,
whether it is still making progress, or that the user can safely leave.

### Desired experience

- Replace the waiting sentence with a compact cutting-room progress rail:
  queued, reading the episode, drafting, refining cuts, quality checking, and
  publishing.
- Show truthful step progress and elapsed time. Show `current / total` only for
  bounded fan-out work such as refining 6 of 11 cuts; do not invent percentages
  or ETAs.
- Keep the previous committed result visible, playable, and read-only while a
  rerun prepares its replacement.
- Let work continue across tab changes, navigation, reloads, offline periods,
  and transient realtime failures. Distinguish “live updates paused” from an
  actual generation failure.
- Announce stage changes politely for assistive technology, respect reduced
  motion, preserve focus and scroll on completion, and never force-switch the
  active tab.

### Implementation constraints already decided

- Stream durable job telemetry, not raw model tokens or partially parsed JSON.
  Moment candidates are still grounded, deduplicated, cut, reviewed, and
  possibly revised; segment plans must pass whole-plan reconciliation and
  partition validation. Final cards remain an atomic database publication.
- Use Trigger.dev Realtime run metadata as the primary transport. Persist the
  same latest stage in the database so reloads and fallbacks have a durable
  snapshot; treat realtime completion only as a signal to refresh the
  authoritative server data once.
- Persist the Trigger run identifier as lifecycle data rather than relying on
  the temporary `counts.dispatchId`, which the current stage writers remove.
- Mint a short-lived read token server-side only after organization/RLS
  authorization, scoped to the exact Trigger run. Never expose
  `TRIGGER_SECRET_KEY` or a task-wide token.
- Keep a small authenticated status endpoint as the fallback for local
  in-process execution, token expiry, or realtime failure. Poll it with
  visibility-aware jittered backoff rather than refreshing the complete RSC
  page every 3.5 seconds.
- If draft cards are ever added, give them an attempt-scoped, explicitly
  read-only `Draft` contract. Moments may publish a grounded/deduplicated draft;
  Segments must not publish row by row because reconciliation can merge or
  reclassify the plan.

### Existing seams to reuse later

- Moment stages are already written by
  [`lib/intelligence/discover-pipeline.ts`](../lib/intelligence/discover-pipeline.ts):
  `brief -> rough -> cut -> review -> revise`.
- Segment stages are already written by
  [`lib/intelligence/segment-pipeline.ts`](../lib/intelligence/segment-pipeline.ts):
  `brief -> rough -> reconcile -> cut -> review`.
- The temporary polling mechanism is
  [`components/sources/refresh-poller.tsx`](../components/sources/refresh-poller.tsx),
  which already names Trigger.dev Realtime as its eventual replacement.
- The source page currently queries committed candidates and segments only
  while their run is `ready`; relaxing that read condition is what lets the
  previous version remain visible during a rerun.

### Promotion checklist

Before moving this into a sprint, re-confirm the installed Next.js and
Trigger.dev APIs, then plan the database lifecycle fields, exact-run token
endpoint, shared progress component, fallback status endpoint, and tests as one
vertical slice. At minimum, tests must cover mid-run reload, token expiry,
cross-organization denial, offline/reconnect, fallback polling, previous-result
preservation during reruns, terminal failure, reduced motion, and mobile layout.
