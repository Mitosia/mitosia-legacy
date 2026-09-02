# Mitosia Pipeline — Implementation Plan

**Status:** v0.1, 2026-08-31. **Companion to** the governing architecture doc
([pipeline-architecture.md](pipeline-architecture.md)). Precedence: the
architecture doc owns system design; [clip-cut-architecture.md](clip-cut-architecture.md)
owns editorial design; this doc owns **sequencing and the harness roster**.
Per-harness spec/sensor detail lives in [sprint-plan.md](sprint-plan.md)
§"Harness workflow roadmap" — this doc orders it and maps it onto the pipeline
phases. Phase C entries are deliberately high-level: each harness gets its own
detailed section (spec, sensors, prompts, gates) extended into this doc in the
PR that starts building it — never before.

## Priority decision (2026-08-31)

**Complete the core harness feature set first — the Python pipeline backend
PLUS the frontend review UI needed to verify each harness.** The review UI is
in scope because an unverifiable harness is an unfinished harness; the
existing source-workspace review panels are the base, adapted per lane.

Everything else user-facing is **deferred** until the harness roster is done:
client delivery (S18), link connectors/intake (S16), billing surfaces, live
progress streaming ([nice-to-haves.md](nice-to-haves.md)), the marketing
site, and any new app feature that is not a review surface for a harness.

## The harness recipe (every workflow, same five layers)

Recorded in [sprint-plan.md](sprint-plan.md) §"Harness workflow roadmap" and
AGENTS.md: **structured perception → declarative spec over enumerated IDs
(never pixels, never raw timestamps) → deterministic execution → computable
sensors → separate evaluator → fixture flywheel.** Per workflow only the spec
shape and the sensor set change.

**Build-order principle:** rank harnesses by the fraction of their quality
that is deterministically checkable (filler removal, captions ≈90%; trailers
≈30%). Adjacency second: prefer the harness that reuses the perception and
boundary machinery already built, so the marginal harness is mostly new
sensors, not new architecture.

---

## Phase A — Chassis (architecture doc P0–P2)

- **A0 — Land the ground.** The docs half landed with the PR that introduced
  this file (architecture doc, AGENTS.md rebuild entry, `pipeline/DECISIONS.md`
  seed, sprint-plan pointers). Remaining: scaffold `pipeline/` (uv + committed
  lockfile, ruff, pyright, pytest) and extend `scripts/local-ci.mjs` with a
  pipeline stage (frozen sync, lint, typecheck, cassette-only tests) so the
  verified-PR delivery flow covers Python from the first code PR.
- **A1 — Eval runner + gold port (P0).** Pure Python, zero infrastructure.
  **Gate:** reproduces the current TS metrics (`pnpm eval`,
  `pnpm moments:metrics` semantics) on existing fixtures within rounding.
- **A2 — Temporal + economics + LLM seam (P1).** Compose gains Temporal
  (auto-setup against the existing pg18 container, separate
  `temporal`/`temporal_visibility` databases, high-port convention). Error
  taxonomy, checkpoint store, budget breaker, ceilings, `llm_calls` logging,
  cassettes. The first Alembic migration ships tenancy correctly: every
  `pipeline.*` tenant table carries `organization_id` + FORCE RLS
  in-migration; a `mitosia_pipeline` role provisioned by script (no
  superuser, no BYPASSRLS, owns nothing); a Python org-scope helper sets the
  same `app.organization_id` GUC as `lib/db/tenant.ts`. Seam contracts
  (`pipeline/contracts/`: view shapes, workflow/signal/query payloads) are
  defined here — B1 consumes them from both languages. **Gate:** chaos test
  passes (worker kill mid-run → resume, zero repeated LLM calls);
  deterministic failure terminal on attempt 1; budget breach completes with
  partials.
- **A3 — Substrate + grounding (P2).** Port grid/snapping/lead-in/paragraph
  behavior with mirrored unit suites. **Gate:** byte-identical grid outputs
  vs TS on 3 recorded sources.

## Phase B — Core lanes, each landing backend + review surface together

- **B1 — Segments lane + seam v1 (P3).** The lane end-to-end to rendered
  chapter files + `chapters.json` passing the full sensor battery, from a
  recorded source, under budget. Seam v1: `public.v_pipeline_*` views
  (`security_invoker`), `@temporalio/client` in Next.js (start / status /
  `review_complete` signal), and the segments panel in the source workspace
  adapted to pipeline runs playing **rendered files** through the
  `/api/media` proxy. Decisions flow as the signal; approve-with-edit writes
  fixtures automatically. The review-signal shape (long-open workflow vs
  complete-at-`ready` + short finalize workflow) is decided at the top of B1
  and recorded in `pipeline/DECISIONS.md`. Every panel adaptation gets its
  Playwright test — the e2e suite is the automated proof that the TS client,
  the views, and the Python workflows agree on the contracts.
- **B2 — Moments lane + its panel (from P5).** Rendered 9:16 clips with
  burned captions playing in the review pane.
- **B3 — Dogfood cutover.** The per-org flag flips **our own org** to Python
  output as soon as a lane passes its M-gate. This is the verification loop,
  not a rollout.
- **B4 — Parity checkpoint (P4, demoted to a report).** Both systems on the
  same sources: boundary-F1, acceptance, cost/source-hour. Informs, does not
  block. `lib/intelligence/*` freezes here (bugfixes only) so the baseline
  stops moving; it is retired as cleanup after Phase C, not before.

**Gate per lane:** an M-style review round on fresh sources through the real
UI — acceptable acceptance rate, under budget, sensor-clean files.

## Phase C — Harness roster (high level)

Spec and sensor detail per harness: [sprint-plan.md](sprint-plan.md)
§"Harness workflow roadmap" (its numbered entries are cited as R1–R7 below;
its per-sprint "home" notes predate the rebuild and are superseded by this
sequencing). Order = computable-fraction descending, then adjacency —
consistent with the roadmap's mid-roll → reframe → multicam adjacency chain,
with R1 first (easiest of the lot) and R6 last (lowest computable fraction).
**Each harness gate:** evals green + an M-style review round on fresh sources
+ COGS within target. Names in parentheses map to the architecture doc's lane
names.

- **C1 — Silence & filler removal** (R1; = "tighten", harness-01). Dense
  intra-clip word/gap-deletion EDLs through the same render/sensor battery.
  Nearly all feedback computable — the proving ground for the file-level
  sensor layer. **Extended 2026-09-02 (Riverside audit):** the same EDL also
  carries tangent/ramble trims inside kept material and deterministic smooth
  cuts (R1's extension), and the audio-enhancement chain (R8) lands here as
  the first enhancement stage the file battery certifies.
- **C2 — Mid-roll ad insertion** (R5). The segment-lane boundary machinery
  re-scored for topic completion and distance from narrative peaks; output is
  ranked insertion points, trivially rendered. Cheapest adjacency in the
  roster.
- **C3 — Captions, translation, dubbing** (R4). Staged internally: captions
  (broadcast-standard deterministic sensors, building on the existing
  `@remotion/captions` + speaker-aware segmentation groundwork) → caption
  translation (pulled forward from post-GA 2026-09-02: brand glossary +
  translation memory, back-translation-consistency judge) → dubbing
  groundwork (a TTS provider seam + duration-fit sensors; full-episode voice
  dubbing itself stays post-GA) → consent-gated word-level voice fixes
  (2026-09-02: the seam at word granularity; refuses without a consent row,
  flags the synthetic range in spec and evidence report; product surface in
  sprint-plan S21).
- **C4 — Transcription ownership A/B** (architecture doc P6: whisperx vs
  AssemblyAI on Modal L4). Placed between editorial harnesses, never during
  one: the substrate's input must not change while a lane is being validated,
  but better word timestamps should land before the vision-heavy harnesses.
  Judged on word-timestamp quality **and diarization quality** (speaker
  labels are load-bearing) and cost; throughput validated empirically. Modal
  is compute behind a Temporal activity — stateless, DB-free (R2 in, artifact
  out). Any switch re-runs all lane evals.
- **C5 — Smart reframe** (R3; the moments lane's center-crop upgrade). First
  vision perception layer (face/saliency tracks, likely Modal GPU); spec is a
  crop keyframe path; the sensors are the product. The ingest `shots`
  artifact already provides scene boundaries.
- **C6 — Multicam auto-switching** (R2; harness-02). Extends C5's vision
  layer with per-camera face presence. **Scope note:** requires multi-file
  session modeling (several camera angles per recording) in upload/ingest —
  the one place Phase C touches the TS app beyond review surfaces. Specified
  2026-09-02 as **multi-track source groups** (sprint-plan S10): per-speaker
  tracks plus the mix, aligned at ingest, diarization bound to track
  identity; per-track activity becomes the primary speaker signal and face
  presence the fallback, which makes C6 cheaper than a pure-vision design.
- **C7 — Best-take assembly** (R7). Script-to-take alignment; the script is
  ground truth. Needs a small script-input surface in the review UI.
- **C8 — Trailer/teaser generation** (R6). Lowest computable fraction, so the
  evaluator carries most weight and human-in-loop runs longest. Deliberately
  last: it spends the fixture flywheel every earlier harness filled.

Standing throughout C: seat auditions on cost-per-correct whenever the market
moves — cheap once A1 exists.

## Phase D — Deferred (resumes after the roster)

Client delivery (S18), connectors/intake (S16), billing surfaces, live
progress streaming, marketing site; retiring `lib/ai/*`,
`lib/intelligence/*`, the five intelligence Trigger tasks, and Mastra
(cleanup, any time after B4's freeze once Phase C no longer needs the
baseline). The 2026-09-02 competitive product additions (assembled clips S8,
NLE handoff S9, episode package S11, audiograms + cross-source v1 S12, batch
intake S16, the voice-fix consent surface S21) are recorded in
[sprint-plan.md](sprint-plan.md) and resume with the rest of the deferred
product work — except anything that is itself a review surface for a lane
(the steerable-discovery brief input, assembled-clip review), which ships
with that lane in Phase B.

## Standing corrections

Recorded as entries in `pipeline/DECISIONS.md` (the architecture-doc
deviation log): org-prefixed S3 keys (the `/api/media` proxy authorizes on
the prefix), Postgres version (pg18/Neon, not 16), Temporal hosting
(dev compose auto-setup; staging self-host on the VPS with a local Postgres
volume; Cloud revisited at cutover), `llm_calls` prefix hashing, the
review-signal shape (open, decided at B1), Python network tuning (the Neon
Happy-Eyeballs lesson), parity demotion + per-lane dogfood cutover, and the
DECISIONS scope rule itself.
