# S6 Implementation Plan — Moment Discovery (Gate M1)

**Status:** Ready to implement. Written 2026-08-25 against main @ `5e5cf0a`, for an implementing agent starting in a **fresh session with none of the S5 session's context**. Everything you need is in this document, the files it names, AGENTS.md, and the project memory index.
**Authored by:** the S5 session (planning + build + staging exit all verified 2026-08-24/25).
**Sprint-plan source:** docs/sprint-plan.md § S6 — re-derived below against what actually exists; where this document and the sprint plan disagree, this document wins (the sprint plan predates all S5 code).

---

## 0. Read these first, in this order

1. `AGENTS.md` — top to bottom. It is the project's law; every standing rule in it applies to this sprint. Pay closest attention to: §Git workflow, §Source intelligence (S5 decisions), §Tenancy and RLS, §UI (hard rule), §Conventions.
2. This document.
3. The S5 seams you will clone or call (skim each, ~15 min total):
   - `lib/intelligence/extract-pipeline.ts`, `extract-enqueue.ts`, `extract-reaper.ts` — **your job-lifecycle templates.** The discovery job is a structural clone of extraction.
   - `lib/intelligence/grounding.ts` — the aligner. You will reuse `alignExtraction`, `normalizeTokens`, `tokenizeWords`, `majoritySpeaker`, and add sentence/pause helpers beside them.
   - `lib/ai/capabilities/source-extraction.ts` — the capability pattern: shared schema, cached prefix, mock, caps-in-schema.
   - `lib/ai/generate.ts` + `lib/ai/config.ts` — `generateStructured` (with `cachedPrefix`), `TASK_ROUTES`, `EFFORT_TIERS`, the budget-math comments.
   - `lib/db/schema/intelligence.ts` + migrations `drizzle/0007–0009` — table + hand-appended-RLS pattern.
   - `app/(app)/sources/[sourceId]/page.tsx`, `components/sources/highlights-panel.tsx`, `ask-panel.tsx` — page wiring, panel conventions, testids, seek/play handlers.
   - `e2e/source-intelligence.spec.ts` — the e2e conventions (upload fixture, mock chain, DB assertions via `queryRows`, interactive-UI coverage).
   - `tests/rls-isolation.test.ts` — how new tables enter the suite (import + seed exactly one row + `TENANT_TABLES` entry).
4. Project memory (`MEMORY.md` index is loaded into your session): `s5-rollout-state` holds the staging war stories behind the rules below; `shared-checkout-contested` and `worktree-e2e-port-3001` are operational hazards that WILL bite you if skipped.

---

## 1. The sprint contract

From docs/sprint-plan.md § S6, unchanged in intent:

- Candidate generation with scoring dimensions (comprehensibility, hook, insight density, relevance, risk) and dedupe.
- Candidate review UI: card gallery + transcript + instant playback with surrounding context.
- Boundary adjustment with snap-to-sentence/pause; select, shortlist, reject with reasons.
- Acceptance-rate and boundary-adjustment instrumentation — **the product's north-star quality metrics**.

**Exit (Gate M1):** a strategist (Rajesh) reviews the top ten candidates from a **fresh** podcast — one never processed before — and accepts most with minor or no boundary changes. M1 is the product's declared core bet; per the sprint plan's risk table, failing it pauses downstream phases. Do not soften the gate.

## 2. Re-derivation — what changed since the sprint plan was written

The plan (2026-08-08) predates all of S2–S5. What exists now, and what that changes:

- **Extraction seeds exist** (`source_extraction`: quotes/stories/claims/qa, grounded ranges, stable ids). Candidates do not start from a blank transcript scan; the generation pass receives the seed inventory in its prompt and may reference seed ids — but is not limited to them (a moment can be extraction-shaped or not).
- **Boundary snapping needs no media work.** AGENTS records the finding: inter-word gaps are pause detection, punctuated words are sentence boundaries. Snap-to-sentence/pause is pure word-timeline math — do NOT add an ffmpeg silence/energy pass.
- **The provenance invariant extends to moments.** Everything the S5 product surfaces is grounded by the aligner. Candidates keep that: each carries a short verbatim `anchorText` that must align inside its claimed range or the candidate is dropped (stored `grounded=false`, never surfaced). No exceptions — this is the property the whole product is built on.
- **Embeddings exist for dedupe** (`transcript_chunk` vectors). Dedupe is deterministic: range-overlap first, embedding-cosine second. No new embedding spend.
- **Cost is a design input, not an afterthought.** S5 landed at ~$0.35–0.42/source-hour cumulative vs the ≤$0.30 target (output tokens dominate; sonnet thinking is billed at $15/M). S6 adds one more sonnet pass; the budget arithmetic in §5 is mandatory, and §10's cost checkpoint is part of the exit.
- **Everything is a follow-on job.** Ingest → transcribe → analyze → extract → **discover** — same claim/enqueue/reaper pattern at every link. Clone it; do not invent a new lifecycle shape.

Explicitly OUT of S6 (do not build): clip rendering/export of any kind (S8/S9), cross-source discovery, brand checks on the risk dimension (S7), auto re-discovery on transcript revision (manual re-run only, like extraction), per-candidate thumbnails (play-in-player is the preview), Batch API.

## 3. Decisions already made — do not relitigate

These were settled by S5's build and staging verification. Implement them as stated; if one appears genuinely impossible, stop and write up why rather than silently doing something else.

**D1 — One generation pass, one shared schema, cached prefix.**
Candidate generation is ONE `generateStructured` call per source on the sonnet tier, using `cachedPrefix` exactly as `source-extraction.ts` does. If you ever split into multiple passes, they MUST share one zod schema and one system string — Anthropic's cache key covers output-format/tools and system before messages, so a per-pass schema silently busts the cache (verified on staging; AGENTS §Source intelligence).

**D2 — Budgets cover adaptive thinking.**
`claude-sonnet-5` thinks by default and thinking counts against `maxOutputTokens`. Size the route as: schema's array bound × worst-case tokens/item + generous thinking headroom. The S5 failures ("No object generated: the model did not return a response" / "could not parse the response") were exactly under-budgeting; `generateStructured` now names budget exhaustion in its error. Never declare `effort` on a haiku route (`EFFORT_TIERS` gate + `tests/ai-config.test.ts` enforce this).

**D3 — Deterministic gates before model judgment.**
The model proposes; pure code disposes. Anchor grounding via the aligner, boundary snapping via the sentence grid, dedupe via range-IoU + chunk-vector cosine, rank capping — all deterministic, all unit-tested, all in `lib/intelligence/` as pure functions.

**D4 — The job lifecycle is a clone of extraction.**
`moment_discovery_run` (one per source, statuses `pending|processing|ready|failed`), claim that treats `processing|ready` as no-op, silence-based reaper scoped to `processing`, automatic chain fires ONCE (conflict-do-nothing insert) from extraction success, re-runs are human actions through a rerun action that flips `ready|failed → pending` (`setWhere status <> 'processing'`). Ledger entry per model call, correlation `discover:{sourceId}:{attempt}`.

**D5 — Human decisions are the north-star instrumentation.**
Accept / shortlist / reject (with a reason enum) and boundary adjustments are first-class columns on the candidate row plus audit entries — never just client state. Acceptance rate and boundary-adjustment magnitude must be computable with one SQL query each; that query IS the M1 measurement.

**D6 — Registry-first UI, e2e-proven interactions.**
No hand-rolled primitives (AGENTS §UI). Every chip, menu, dialog, and button ships inside `e2e/` coverage in the same PR. Follow the testid conventions of `highlights-panel.tsx`.

## 4. Schema (PR-A)

Add to `lib/db/schema/intelligence.ts` (same file, same conventions — org FK, `uuidv7()` ids, timestamps helper where lifecycle needs `updatedAt`):

**`moment_discovery_run`** — clone `sourceExtractionRun` field-for-field (attempts, contextSnapshotId, counts jsonb, error, models jsonb, organizationId, revision, sourceId unique, status) renamed for discovery.

**`moment_candidate`**:

| column | type | notes |
|---|---|---|
| id | uuid pk uuidv7 | stable — S8's edit specs will reference it |
| organizationId / sourceId / runId | fks | runId → moment_discovery_run cascade |
| rank | integer | 0-based after dedupe+sort; display order |
| title | text | specific, not generic |
| hook | text | one sentence: why a viewer stops scrolling |
| summary | text | 1–2 sentences |
| startMs / endMs | integer | SNAPPED bounds (sentence-aligned) — what plays |
| rawStartMs / rawEndMs | integer | model's original claim, pre-snap (instrumentation: how far snapping moved) |
| adjustedStartMs / adjustedEndMs | integer nullable | human boundary edits; null until touched |
| anchorText | text | verbatim phrase, aligner-verified |
| grounded / groundingScore | boolean / real | aligner outcome; ungrounded never surfaces |
| scores | jsonb | `{comprehensibility, hook, insight, relevance, risk}` each 0–1 |
| composite | real | see §5 weights |
| sensitive | boolean | risk ≥ 0.6 → badge in UI, never auto-exclusion |
| seedIds | jsonb | source_extraction ids the model says it drew on (may be empty) |
| dedupeGroup | integer nullable | group id; the kept candidate and its suppressed duplicates share it |
| suppressed | boolean | true = lost its dedupe group; kept for instrumentation, hidden by default |
| status | text enum | `proposed \| shortlisted \| accepted \| rejected` (default proposed) |
| rejectReason | text enum nullable | `not_interesting \| wrong_boundaries \| out_of_context \| sensitive \| duplicate \| other` |
| rejectNote | text nullable | optional free text |
| decidedBy / decidedAt | user fk (set null) / timestamp | audit anchor |
| revision | integer | transcript revision discovered from |
| createdAt | timestamp | |

Indexes: org idx; `(sourceId, rank)`; runId idx. Migration: `pnpm db:generate --name s6-moment-discovery`, then **hand-append** ENABLE + FORCE RLS + org-isolation policies for BOTH tables to the generated SQL — copy the block shape from `drizzle/0009_s5-source-qa.sql` verbatim. Add both tables to `tests/rls-isolation.test.ts` (import, one seeded row each in `seedOrgChain`, `TENANT_TABLES` entries). The enum columns are TypeScript-level only (drizzle text enum adds no DB constraint) — extending them later needs no migration.

## 5. Discovery capability + pipeline (PR-A)

**Route** (`lib/ai/config.ts`):
```
"moment-discovery.candidates": { maxOutputTokens: 24_000, tier: "sonnet" }
```
Budget math (write it in the route comment, per the S5 rule): schema bound 24 items × ~350 tokens/item (title+hook+summary+anchor+scores) ≈ 8.5k + thinking headroom ≈ well under 24k. Schema array bound `.max(24)`; instructions say "at most 18, ranked" — the bound is the hard ceiling the cap trims under.

**Capability** (`lib/ai/capabilities/moment-discovery.ts`), mirroring `source-extraction.ts`:
- Input: contextPack (`kind: "moment-discovery"` — extend the union in `lib/ai/context.ts`), durationMs, transcript, analysis context (summary + chapters), and the **seed inventory**: a compact list of grounded extractions (`[id] kind @mm:ss–mm:ss: title-or-text-first-100-chars`).
- Schema (chained `.extend()` so property order survives formatters — S4 lesson, see `editorialOutputSchema`): items of `{ startMs, endMs, anchorText (verbatim, ≤160 chars), title (≤120), hook (≤200), summary (≤300), seedIds (array of uuid strings, may be empty), scores: {comprehensibility, hook, insight, relevance, risk} each 0–1 }`. Emit span first, characterization after, scores last.
- Prompt: candidates are **standalone clip-worthy moments 20–90 seconds long** (instruct the range; snapping enforces nothing here), judged for: comprehensibility without outside context, scroll-stopping hook, insight density, relevance to the recording's themes, and risk (sensitive/controversial/reputational — flag, don't censor). `anchorText` must be VERBATIM words from inside the moment. Never invent content.
- Mock (`ANALYSIS_PROVIDER=mock`): deterministic candidates derived from `buildParagraphs` — at least 3, spanning different paragraphs, one with `risk: 0.8` (exercises the sensitive badge), anchors copied verbatim from paragraph words so grounding succeeds, one pair deliberately overlapping >60% (exercises dedupe visibly in e2e).

**Deterministic post-processing** (`lib/intelligence/moments.ts`, pure, exported for tests — this file is the sprint's core IP):
1. `sentenceStarts(words)` — indices where a sentence begins (previous word ends with `. ! ?` — same heuristic as `scoreSummary`'s `SENTENCE_END`; first word is always a start).
2. `pauseBoundaries(words, minGapMs = 700)` — word indices preceded by an inter-word gap ≥ minGapMs.
3. `snapToSentences(range, words)` — start snaps to the nearest sentence start at-or-before `startMs` (fallback: nearest pause boundary); end snaps to the nearest sentence end at-or-after `endMs`, capped at +10s growth per side (a bad model range must not swallow a minute of audio).
4. `groundCandidate(item, timedTokens)` — `alignExtraction(anchorText, startMs, endMs, tokens)`; grounded requires the aligned anchor to sit INSIDE the snapped range.
5. `dedupeCandidates(candidates, chunks)` — pass 1: range IoU > 0.5 → same group. Pass 2 (semantic, the "same story told twice" case — Karma's diamond merchant is the canonical example): mean vector of overlapping `transcript_chunk` embeddings per candidate, pairwise cosine ≥ 0.92 → same group. Keep the highest-composite member per group; others `suppressed: true`.
6. `compositeScore(scores)` = `0.3*hook + 0.25*insight + 0.2*comprehensibility + 0.25*relevance` (risk deliberately excluded from the composite — it's a flag, not a demerit; weights are a named constant with a comment that review data retunes them post-M1).
7. Rank survivors by composite desc, assign `rank`, keep all (suppressed included) in the table.

**Pipeline** (`lib/intelligence/discover-pipeline.ts`): clone `extract-pipeline.ts` — claim → `loadCurrentTranscript` → assemble context + seeds (grounded extractions only) → capability → post-process (needs the source's chunks for dedupe: select id/startMs/endMs/embedding from `transcript_chunk`; if the index isn't ready, skip pass-2 dedupe rather than fail — range-IoU still runs) → persist in one `withOrgScope` tx (context snapshot, delete-and-replace candidates for the source, update run with counts `{proposed, grounded, suppressed}`, ledger `discover:{sourceId}:{attempt}` with usage + costUsd). Failure path: sanitized error on the run row, rethrow.

**Enqueue/reaper/task**: clone `extract-enqueue.ts` (both `enqueueDiscovery` — conflict-do-nothing, and `enqueueDiscoveryRerun` — setWhere flip), `extract-reaper.ts` (`DISCOVERY_STALL_TTL_MINUTES = 20` in `lib/intelligence/window.ts`), and `trigger/extract-source.ts` → `trigger/discover-moments.ts` (id `discover-moments`; keep `tuneOutboundConnections()` at module scope and telemetry in the `init` hook — standing rules). Chain: in `extract-pipeline.ts`'s `runExtraction`, after the persist transaction, enqueue discovery inside a contained try/catch exactly like analysis→extraction chaining.

## 6. Review UI (PR-B)

`components/sources/moments-panel.tsx` (client), rendered by the source page between the Highlights panel and the Ask panel; plus a "Find moments" missing-state CTA when analysis+extraction are ready but no run exists (clone the `highlights-panel` missing state — this is also how the two existing staging sources get their first run), pending/processing and failed-with-retry states (clone `RerunExtractionButton` shape via a shared or parallel `RerunDiscoveryButton`).

Ready state:
- Header: "Moments" + count + a subtle acceptance readout once any decision exists ("4 accepted · 2 rejected").
- Default view: top candidates by rank, `status != rejected`, `suppressed = false`, capped at 10 with a "Show all N" toggle (the exit test reviews the top ten — make that the default frame). A "Rejected" toggle reveals decided-against rows.
- Card per candidate: rank, title, hook, `mm:ss–mm:ss` + duration chip, score chips (composite prominent; per-dimension in a tooltip or compact row), `Sensitive` outline badge when flagged, seed-count hint when `seedIds` non-empty.
- **Playback**: clicking the card seeks AND plays with context — `video.currentTime = (startMs − 3000)/1000` (3s pre-roll, floor 0), `video.play().catch(() => {})`. Reuse the exact handler shape from `ask-panel.tsx`'s `onPlay` (data attributes + one callback — biome's `noJsxPropsBind` forbids inline arrows in JSX props).
- **Boundary adjustment**: in/out nudge buttons per side — ‹ / › move the boundary to the previous/next **sentence start** (in) / **sentence end** (out), computed client-side from the transcript words the page already loads for the transcript panel (import the pure helpers from `lib/intelligence/moments.ts`; they are client-safe). Show the running delta ("in +4.2s"). "Play from in-point" after each nudge. Persist via a `saveBoundariesAction` (writes adjustedStartMs/adjustedEndMs + audit `moment.boundaries_adjusted` with the deltas in metadata).
- **Decisions**: Accept / Shortlist / Reject buttons. Reject opens a registry Select (or DropdownMenu) with the reason enum + optional note — **it's interactive UI: the e2e must open it** (AGENTS §UI; Base UI context crashes only fire on interaction). Actions write status/decidedBy/decidedAt + audit `moment.accepted|shortlisted|rejected`.

Server actions in `lib/actions/moments.ts` (clone the `lib/actions/intelligence.ts` conventions: zod-parse formData, `requireOrg`, `withOrgScope`, audit in-tx, `revalidatePath`). Testids: `moments-panel`, `moment-card`, `moment-accept`, `moment-reject`, `moment-reject-reason`, `moment-nudge-in-prev` etc., `find-moments`, `rerun-discovery`.

Page wiring (`app/(app)/sources/[sourceId]/page.tsx`): query run `{status, revision, error, stalled}` + candidates (ready runs, ordered by rank) + schedule the discovery reaper when stalled, all following the extraction-run wiring that's already there. Include the run in `pageIsSettled`.

## 7. Instrumentation (PR-B, non-negotiable)

The two north-star metrics, as plain SQL over the tables (no new infra):
- **Acceptance rate** = accepted / (accepted + rejected), over non-suppressed candidates of a source (and across sources).
- **Boundary adjustment** = mean |adjusted − snapped| per side over accepted candidates (null adjusted = 0).

Ship `scripts/moment-metrics.ts` (esbuild-bundled like `run-evals`, `pnpm moments:metrics`) printing both per source and overall — this is what the M1 review reads out. Every decision/adjustment also lands in `audit_log` via the actions (metadata: candidateId, reason, deltas), so the metrics are reconstructable even after re-runs replace candidate rows. **Because re-runs delete-and-replace candidates, decided rows are the record of the review**: the rerun action must refuse (with a clear error) when any candidate of the source has status ≠ proposed, unless a `force` flag is set — losing a strategist's review to a casual re-run is unacceptable.

## 8. Evals + tests (PR-A/C)

- Unit (`tests/intelligence-moments.test.ts`): sentence grid on synthetic words; snapping (inside-sentence range expands to boundaries; growth cap honored; pause fallback), anchor-grounding gate, IoU dedupe, cosine dedupe with hand-built vectors, composite weights, rank stability, determinism.
- Eval (`scripts/run-evals.ts` + `lib/ai/evals/scorers.ts`): `scoreMoments(candidates, durationMs)` deterministic — grounded rate ≥ 0.8 threshold, snapped bounds land on sentence starts/ends, durations within 10–120s for ≥80% of survivors, no surviving pair with IoU > 0.5, scores in range. Run the capability + post-processing on the committed fixture like extraction does. Also add the carried S5 item: a **citation-relevance judge** to the qa eval (LLM judge, key-gated like `judgeSummary`) — the observed failure mode is a range-valid but topically irrelevant citation attached to an otherwise-correct answer.
- E2e: extend `e2e/source-intelligence.spec.ts` (the mock chain now ends in discovery): moments panel renders ≥3 cards; DB-assert candidates grounded with snapped bounds inside the fixture duration and the mock's overlapping pair deduped (one suppressed); card click seeks the player (assert `currentTime` ≈ startMs−3s); nudge changes the shown delta and persists (DB assert adjusted columns); accept one (DB assert status+audit); reject one **through the reason menu** with `pageerror` sweep; rerun-refusal when decided rows exist surfaces its error.

## 9. PR train

Three stacked PRs, each green before the next, each recording enacted decisions in AGENTS.md (§Source intelligence grows an S6 block) in the same PR:

- **PR-A `feat/s6-moment-discovery`** — schema/migration/RLS, `moments.ts` pure lib + tests, capability + mock, route, pipeline/enqueue/reaper/task, chain from extraction, ledger, deterministic eval, e2e chain assertion (panel can land as a minimal read-only list here or in PR-B — implementer's call, but the e2e chain proof lands here).
- **PR-B `feat/s6-review-ui`** — full panel, actions, boundary nudges, decisions, instrumentation writes, `pnpm moments:metrics`, interaction e2e.
- **PR-C `feat/s6-quality-cost`** — citation-relevance judge, cost measurements + tuning (see §10), any review-driven polish, AGENTS/docs finalization.

## 10. Cost checkpoint (folded into the sprint, PR-C)

S5 closed at ~$0.35–0.42/source-hour cumulative vs the ≤$0.30 target, dominated by sonnet output (thinking) tokens. In this sprint:
1. Measure a fresh extraction+discovery run's real cost from Langfuse usage (LANGFUSE keys are in the local `.env`; the S5 memory shows the query pattern) — the S5 `.14` span caps may already have moved extraction; get the number, don't assume.
2. Cheapest levers, in order of evidence-gathering cost: `effort: "medium"` on the sonnet extraction passes (supported tier; run `pnpm eval` before/after — thresholds are the gate), then a claims-on-haiku experiment via evals only (no prod change without eval parity).
3. Report $/source-hour for the full chain (analysis+extraction+discovery+index) in the PR-C description and memory. If > $0.35, list the next lever; do not silently accept it.

## 11. Session-learned hazards (will bite you; 2 minutes to read)

- **Work in a git worktree, not the main checkout.** Parallel sessions share `/Users/rkpattanaik/Projects/MitosiaAI/mitosia` and switch branches under each other (this destroyed and then required surgical repair of an S5 PR). `git worktree add .claude/worktrees/s6 -b feat/s6-moment-discovery origin/main`, enter it, `pnpm install`, `cp ../../..../.env .env` (copy the main checkout's `.env`). Stacked-PR note: after a squash-merge of the base PR, re-stack the next branch with `git rebase --onto origin/main <old-base-tip>` — squash rewrites SHAs and GitHub will report phantom conflicts otherwise.
- **Unit tests**: `TEST_DATABASE_URL=postgres://mitosia:mitosia@localhost:55433/mitosia_test pnpm test` (inline, not in any env file; DB is disposable). Compose must be up (`docker compose up -d`; the postgres image is `pgvector/pgvector:pg18`).
- **E2e**: `TRIGGER_SECRET_KEY= pnpm e2e <spec>` — the local `.env` has a real key and without blanking it every upload sits at "Queued" forever. Check nothing else is listening on 3001 first (`lsof -i :3001`); if the main checkout's dev server runs, use `E2E_PORT` + matching `BETTER_AUTH_URL`.
- **Lint loop**: `pnpm exec ultracite fix` then `pnpm lint`; biome here enforces alphabetized keys, no inline JSX arrow props, top-level regexes, destructuring, and a cognitive-complexity cap of 20 (extract helpers rather than suppress). Gate on exit codes, not tail output.
- **Merging**: you may find `gh pr merge` blocked by the permission system — that's a deliberate human gate; ask Rajesh to click merge rather than working around it. Merges to main auto-deploy staging AND the Trigger worker (CI `deploy-trigger` job; the switch is armed). Manual worker deploy if ever needed: `npx trigger.dev@<exact @trigger.dev/sdk version from package.json> deploy` — never `@latest`.
- **Staging exercise needs Rajesh's browser session** (claude-in-chrome, ask him to sign in) or his own clicks. The Trigger dashboard (cloud.trigger.dev, his Chrome session) is where failed runs are diagnosed and replayed; Langfuse (`LANGFUSE_BASE_URL` in `.env` — the JP region, API 401s on any other host) is where generation usage lives.
- **The mock convention is load-bearing**: `ANALYSIS_PROVIDER=mock` + `TRANSCRIPTION_PROVIDER=mock` + `EMBEDDING_PROVIDER=mock` drive the whole chain deterministically in e2e/CI. Your mock candidates must ground (copy verbatim words from `buildParagraphs`) or the e2e proves nothing.
- **Voyage** now has a payment method (standard rate limits) and the adapter has 429 backoff (#79); embedding cost is ~free under the 200M-token allotment.

## 12. Exit — Gate M1

Sequence, after the train is merged and deployed:

1. **Fresh source**: ask Rajesh to upload a NEW real podcast episode (never processed; ideally interview-style, 40–90 min). The whole chain must run hands-off: ingest → transcript → analysis → extraction → discovery, ending with a populated Moments panel. Any manual intervention beyond the upload is a finding.
2. **The review**: Rajesh reviews the top ten in the UI — plays each (3s pre-roll), adjusts boundaries where needed, accepts/shortlists/rejects with reasons. No coaching; the UI must carry it.
3. **Measure**: `pnpm moments:metrics` — M1 passes if acceptance ≥ 7/10 with boundary adjustments "minor or none" (median |delta| ≤ ~3s per side is the working definition; record the actual numbers whatever they are).
4. Also verify: Langfuse trace for the discovery pass (cache hit if extraction ran in the same window), ledger `discover:*` rows, dedupe visibly collapsing at least one duplicate on real content (Karma's twice-told diamond-merchant story is a known natural test if the fresh source lacks one), sensitive badge behavior, cost checkpoint (§10).
5. Record a demo (claude-in-chrome `gif_creator` worked well for S5 — `~/Downloads/s5-exit-demo-karma.gif` is the precedent), update `s6` memory state, and update this doc's status line to reflect the outcome. **If the gate fails, that is a legitimate, plan-anticipated outcome**: write up which dimension failed (candidate quality? boundaries? UI?) — the sprint plan's contingency is to pause downstream phases and iterate on curation quality, not to ship anyway.

## 13. Open to implementer judgment

Card layout details and score presentation; whether PR-A ships a minimal read-only panel; exact nudge-button iconography; the pause-gap default (700ms is a starting point — check it against the fixture); whether `suppressed` duplicates get a "show duplicates" affordance in v1; snapping growth-cap value; anything visual — subject to the registry-first rule and e2e coverage. When in doubt about a seam, copy the S5 shape next to it.
