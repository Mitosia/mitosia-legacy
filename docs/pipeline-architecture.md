# MITOSIA PIPELINE — Consolidated Implementation Architecture (v1.0)

> **Audience:** Claude Code. This is the SINGLE governing document for building Mitosia's Python harness layer. It consolidates and SUPERSEDES: `mitosia-pipeline-bootstrap.md`, `ARCHITECTURE-v2-errata.md`, and `ARCHITECTURE.md` v2. Two in-repo documents remain live references for editorial detail and are NOT superseded: `docs/clip-cut-architecture.md` (pass topology, prompts, research base) and `docs/episode-to-clips.md` (editorial method). Where this document and those conflict on editorial design, THEY win; on everything else, THIS document wins. The existing TS code is a behavioral reference only — port rules and incidents, never transliterate. Log every deviation in `DECISIONS.md`.

---

## 1. Scope

**Build in Python (`pipeline/` in the existing monorepo):** all video-editing harness workflows — cut-point substrate, LLM selection passes (segments + moments lanes; later: tighten, multicam), deterministic sensors, render/cut execution, evaluator/verifier passes, eval runner, fixture logic — orchestrated on Temporal (Python workers), with the economics layer built in from day one.

**Do NOT touch:** the Next.js app (auth, orgs, billing, upload, review UI, email); ingest/transcode/HLS (`lib/media/`, `trigger/ingest-source.ts`) — proven and incident-hardened, stays in TS, the pipeline consumes its artifacts; transcription provider calls (AssemblyAI/Deepgram) — the pipeline reads the stored transcript until Phase P6's whisperx A/B decides otherwise.

**Retire only after P5 parity:** `lib/ai/*`, `lib/intelligence/*`, the five intelligence Trigger tasks, the Mastra dependency.

## 2. Principles (apply to every component)

1. **Model proposes, code disposes.** LLMs select from enumerated IDs (sentence/paragraph); they never emit timestamps, never touch pixels. Deterministic code resolves IDs → words → ms and executes with ffmpeg.
2. **Constraints live in schemas and sensors, not prompts.** Prompts name NO counts and NO durations (measured policy: duration-hinted prompts caused over-segmentation). Bounds are enforced by sensors and the reconciler after generation.
3. **Failure is cheap, progress is durable.** Every model decision is checkpointed; no call is ever re-paid for the same input; deterministic failures never retry; budget is a breaker, not a report.
4. **Verification is external and independent.** Generator ≠ evaluator; the final verifier is a different model FAMILY; reviewers see rendered evidence (actual span text), never the proposer's claims; grounding is mandatory — verbatim or it doesn't ship.
5. **One variable at a time.** P0–P4 change the chassis only (same prompts, same model routes, same transcription). Models, providers, and editorial design change ≥ P6, one at a time, gated by the eval runner.
6. **Seats are won by measurement.** Every pass is a "seat" with a routed model; routing is decided by cost-per-correct on fixtures, re-run when the market moves. Never by rate card or benchmark table.

## 3. Tech stack (prescriptive)

| Concern | Choice |
|---|---|
| Language | Python 3.12 |
| Orchestration | Temporal (Python SDK). Local: docker-compose Temporal. Prod: Temporal Cloud `[AGENT-DECIDES: cloud vs self-host on existing Postgres; record in DECISIONS.md]` |
| DB | Postgres 16 (existing instance), new schema `pipeline`, SQLAlchemy 2 + Alembic |
| Object storage | Existing S3-compatible bucket (same as app) |
| Wire/validation | pydantic v2 (local rich validation) + jsonschema (portable wire schemas) |
| LLM transport | OpenAI-compatible client (httpx) against OpenRouter. NO agent framework (no ADK/Mastra/LangGraph — frameworks own control flow; harnesses require us to own it) |
| Embeddings | Voyage (as today) for dedupe cosine |
| Media | ffmpeg 8.1.x pinned via the existing checksummed-asset scripts (`scripts/ffmpeg-pin.mjs` remains the single source of truth; the worker image reuses it) |
| Telemetry | structlog JSON (every line carries workflow/run/clip ids) + OTel → Langfuse (per-call spans, verify cache reads in telemetry, never assume) |
| Testing | pytest; recorded-response cassettes for all LLM calls in CI |

Datastore decision is closed: Postgres, not Convex (Convex server functions are TS-only; Temporal persists to Postgres; the app layer is already Postgres-shaped).

## 4. Repository layout

```
pipeline/
├── pyproject.toml
├── src/clipper/
│   ├── config.py            # ALL thresholds, budgets, model routes, prompt versions
│   ├── db/                  # SQLAlchemy models + Alembic (schema: pipeline)
│   ├── workflows/           # Temporal workflows + activities per lane
│   ├── substrate/           # grids, snapping, lead-in/out, question marks, renderings
│   ├── llm/                 # generate seam, routing, budget, portable schemas
│   ├── passes/              # director, rough, reconcile, cutter, publisher, verify
│   ├── grounding/           # aligner + anchor lineage
│   ├── sensors/             # EDL-level + file-level batteries
│   ├── render/              # ffmpeg wrappers (ONLY place ffmpeg strings exist)
│   ├── evals/               # fixtures, metrics, runner CLI
│   └── seam/                # views DDL, signal/query payload types, ledger writer
└── tests/                   # unit + integration + cassettes + chaos
```

## 5. Seam contract (Next.js ↔ pipeline)

- **Temporal is the API.** Python workers implement workflows; Next.js uses Temporal's TypeScript client to start workflows, query, and signal. No HTTP control plane. Signals: `review_complete(decisions)`, `cancel(reason)`, `raise_budget(usd)`. Queries: `status()`, `cost_so_far()`.
- **Data ownership.** Pipeline owns schema `pipeline.*`; Next.js reads via `public.v_pipeline_*` SQL views and NEVER writes pipeline tables. Pipeline writes usage into the existing ledger tables using the existing correlation-ID convention and row shapes (port the shapes from `lib/ledger.ts`, not the code).
- **Status UX.** Preserve attempt-parking semantics: a non-final failure never surfaces as terminal in the views; only a final/deterministic failure or budget breach does. The existing refresh-poller and S6 review panel are the UI — review actions arrive as the `review_complete` signal.
- **Artifacts.** S3: `indexes/{video}.json`, `plans/{run}/...` (per-pass artifacts), `clips/{run}/{ordinal}_{id}.mp4` + sidecars, `chapters/{run}/chapters.json` + `youtube_description.txt`. All artifacts immutable; every artifact and checkpoint keys on `transcript_revision` (hash of the transcript the run consumed).

## 6. Data model (schema `pipeline`)

- `runs(id, source_id, lane enum[segments,moments,tighten,multicam], status, transcript_revision, budget_usd, cost_usd, dispatch_count, params jsonb, created_at, updated_at)`
- `pass_artifacts(id, run_id, pass_name, input_hash, payload jsonb, usage jsonb, created_at)` — UNIQUE(pass_name, input_hash); the checkpoint store
- `clips(id, run_id, ordinal, edl jsonb, storage_key, status enum[proposed,sensor_failed,rendered,eval_passed,eval_failed,approved,rejected,published], sensor_report jsonb, eval_report jsonb, retry_count)`
- `llm_calls(id, run_id, clip_id nullable, seat, model, provider, upstream_provider, attempts, attempted_models jsonb, in_tokens, out_tokens, cache_read, cache_write, cost_usd, latency_ms, request jsonb, response jsonb)`
- `fixtures(id, source_id, lane, gold jsonb, source enum[human_review,manual_import], notes)`
- `eval_runs(id, git_sha, config_hash, lane, metrics jsonb)` — includes cost-per-correct per seat×model
- `failure_evidence(id, run_id, pass_name, kind, payload jsonb)` — rejected plans, validator errors, repair transcripts

## 7. Cut-point substrate (Pass 0 — deterministic, no model)

Port as behavior from `lib/intelligence/moments.ts` / `grid.ts` / `lib/transcription/paragraphs.ts`, with unit tests mirroring the TS suites. **P2 gate: byte-identical grid outputs vs TS on 3 recorded sources.**

Contents: word timeline (integer ms) → sentence grid (starts/ends), pause boundaries, speaker-turn grid, question annotation (`·q` on interrogative-shaped turns), paragraph grouping, shot-change grid (consumed from the ingest artifact). Two renderings with stable enumerated IDs: coarse (one line per paragraph, `P042`) and fine (one line per sentence, `s0417|14:02|S2: text` with pause/turn/shot glyphs). Instructions before transcript; mm:ss visible for pacing reasoning but never an output coordinate.

## 8. Editorial pass topology (segments + moments)

Implement the cutting room exactly as `docs/clip-cut-architecture.md` §4 defines it (that document owns prompts and editorial rules):

1. **Director** — episode brief (spine, marquee arcs, tone, drop territories); persists as a durable artifact + checkpoint.
2. **Rough Editors** (per lane) — TOC-first contract; coarse mandate ("identify the region; a dedicated cutter places the exact cut"); paragraph-ID span selection; drop-with-reason taxonomy (housekeeping/sponsor/low_energy/weaker_telling/thin/other); scored on recall.
3. **Reconciler** (deterministic + bounded model assist as the TS design specifies) — exact-cover validation: keeps+drops form a first-to-last partition of the paragraph range; partition-safe merge/nudge.
4. **Cutter** — per-clip fine cut over a local sentence window (±20 sentences), sentence-ID in/out selection; lead-in captures the provoking question/setup (question annotation upgrades this to semantic); lead-out ends on the payoff sentence, never into the next beat.
5. **Publisher** — reviews the complete post-Cutter plan; may merge, split, recut, reclassify, repackage; packaging (titles name the payoff, standalone in search; description; tags; thumbnail frame at emotional peak).
6. **Independent-family Verify** — a different model family verifies the COMPILED plan once (never per clip) against rendered evidence before `ready`.
7. **Grounding** throughout — anchor text must align verbatim (aligner + anchor-candidate lineage); a fine cut that excludes the first anchor recovers via lineage.
8. **Dedupe** — twice-told-story resolution: IoU + chunk-vector cosine; keep the better telling.

Additions this build introduces (not in the TS system):
- **Shared-boundary rule:** the boundary between adjacent segment clips resolves to ONE cut point inside a shared silence gap; trimmed dead air belongs to neither; any boundary edit (human or retry) cascades to the neighbor and re-runs both clips' sensors.
- **Both lanes emit word-index EDLs** resolved from sentence IDs; render consumes EDLs only.

## 9. LLM seam (`llm/`)

Reimplement the `generate.ts` contract; the TS file is the behavioral spec:
- One native structured call per operation (no framework second-pass structuring); pydantic-validated locally against a small strict portable JSON wire schema.
- Ordered failover across the routed candidate list; cap 2 attempts per model; **halt failover when 2 independent models fail LOCAL validation** (the defect is the prompt/validator, not the model) → deterministic failure.
- One bounded error-directed repair per operation: the repair call sees the rejected output + exact validation errors. Repair exhausted → deterministic failure.
- Family exclusion: judge/verifier seats exclude the generator's model family by config.
- Cached shared prefix (context + transcript) with hashed sticky-session key; **verify cache reads in telemetry**.
- **Provider pinning for open-weight models:** the same model ID can differ in quantization/structured-output behavior across OpenRouter hosts. Eval and production must pin the same provider (or use accuracy-biased routing); an eval pass certifies a model-host pair.
- Every call logged to `llm_calls` with seat, models attempted, cache stats, cost.

### 9.1 Seat routing

Routing lives in `config.py` as `seat → [model candidates]`, changed only via audition. Initial routes = current production routes (one variable at a time). Standing audition process (≥ P6): run candidates on fixtures per seat; decide on **cost-per-correct** (boundary-F1/acceptance per dollar, thinking tokens included — reasoning-always-on models bill hidden output); publish results to `eval_runs`. Expected steady state: frontier model in the rough-partition seat until beaten; budget-class models (K2.5/Flash-class) in high-volume constrained seats (fine cuts, packaging, classification); a different-family long-context model (e.g. Kimi K3, 1M context, cached input) as verifier candidate. Production runs ONE model per seat — the pool exists for failover and audition, never ensemble fan-out.

## 10. Economics layer (non-negotiable, built before any real prompt runs)

1. **Error taxonomy.** Every failure is `transient` (429/5xx/timeout/provider flake) or `deterministic` (schema-invalid after repair, 2-family validation halt, exact-cover failure after bounded repair, grounding failure). Deterministic → Temporal `ApplicationError(non_retryable=True)`: attempt 1 is terminal. Transient → per-activity retry (max 3, exponential backoff). NO uniform task-level retry exists anywhere.
2. **Checkpoints.** Every pass is an activity wrapped in load-or-run against `pass_artifacts` keyed on `hash(transcript_revision + pass_name + prompt_version + seat_route + params)`. Workflow replays and human "Try again" re-pay ZERO tokens for unchanged passes.
3. **Budget breaker.** `budget_usd_per_source_hour` → run budget at start; accumulator checked BEFORE each LLM activity; breach → persist partials, status `budget_exceeded`, workflow COMPLETES (not fails). Raising budget is an explicit signal.
4. **Ceilings.** Run lifetime `dispatch_count` ≤ 3; failover ≤ 2/model; 1 repair/operation; Publisher revision ≤ 1; Cutter retry per clip ≤ 1. All config, all breaches ledger events.
5. **Failure evidence.** Rejected plans, validator errors, repair transcripts persist to `failure_evidence`. A failed run must be reviewable.
6. **COGS metric.** Per-run `cost_usd / source_hours` maintained on the run row and surfaced in views — the sustainability dashboard number.

## 11. Sensors

**Whole-EDL (segments):** exact partition (reconciler-enforced), chapter-count sanity vs duration, per-chapter duration bounds (undersized → merge into shorter neighbor; oversized → deterministic failure to review).
**Per-clip pre-render (both lanes):** sentence-boundary integrity (auto-walk ≤15 words); cut-snap ±150 ms to silence/scene else snap ≤500 ms (segments: shared-boundary single cut point); moments: 15–90 s duration + pairwise overlap ≤20%.
**Post-render (file battery, new):** blackdetect/freezedetect at first/last 1 s; two-pass loudnorm to −14 LUFS ±1.5; duration vs EDL ±200 ms; onset clearance on rendered audio; caption sync ≤120 ms when burned.
Sensor failures: auto-fix where defined; otherwise moments drop the clip, segments route the affected chapter(s) to review (a partition can't silently lose a member). Auto-fixes never invoke an LLM.

## 12. Render & export

Program cut from the ORIGINAL master (S2 rule) with duration verification. **Stream-copy preferred:** `-ss/-to -c copy` when both cuts within 100 ms of keyframes (keyframe map via ffprobe); else re-encode `libx264 -preset veryfast -crf 20`. Segments keep source aspect + sidecar .srt; moments render 9:16 center-crop + burned .ass captions (reframe upgrade is a later harness). Outputs + `chapters.json` + YouTube-description timestamps at finalize. All ffmpeg strings live in `render/` and `sensors/` wrappers only.

## 13. Evals & fixtures

- P0 ports existing gold: `evals/fixtures`, `segmentBoundaryGold` semantics, `moments:metrics` readout — Python runner must reproduce current TS metrics on existing gold within rounding before any pipeline code.
- Metrics: segments — boundary-F1 (±2 s) primary, WindowDiff secondary, chapter-count delta, acceptance rate from review; moments — temporal IoU, precision/recall @ IoU 0.5; all — evaluator pass rate, cost-per-correct per seat×model.
- CI gates: boundary-F1 drop > 0.05 vs main fails; grid byte-parity suite; chaos test (kill worker mid-run → resume from checkpoints with zero repeated LLM calls).
- Every review approve-with-edit writes a fixture automatically. Metrics compare against one editor's choices — regression tripwires, not absolute truth.

## 14. Phases (gates are CI-runnable commands)

- **P0 — Eval runner + gold port.** Gate: reproduces current TS metrics on existing fixtures.
- **P1 — Temporal scaffold + economics + LLM seam.** Stub activities, cassette models. Gate: chaos test passes; deterministic failure aborts on attempt 1; budget breach completes with partials.
- **P2 — Substrate + grounding + reconciler validation.** Gate: byte-parity vs TS grids on 3 recorded sources.
- **P3 — Segments lane, architecture FROZEN.** Same prompts, routes, transcription. Gate: end-to-end on a recorded source completes under budget.
- **P4 — Shadow parity.** Both systems on the same sources. Gate: boundary-F1 + acceptance parity-or-better AND cost/source-hour ≤ TS baseline. Only then users see Python output.
- **P5 — Cutover (per-org flag) + moments lane + retire TS intelligence code.**
- **P6+ — Improve, one variable at a time:** whisperx-vs-AssemblyAI A/B on word-timestamp quality against the substrate (decides transcription ownership; Modal L4 workers, validate throughput empirically); K3 + budget-model seat auditions; post-M-gate editorial rounds; new lanes — tighten (harness-01 doc), multicam (harness-02 doc) — as new workflows on this chassis.

## 15. Testing requirements

Unit: substrate, grounding, reconciler, every sensor incl. shared-boundary cascade, taxonomy/budget logic, checkpoint keying. Integration: docker-compose (postgres, minio, temporal) + bundled 3-min source + cassettes, one run per lane to `evaluating`. Chaos: worker kill mid-run (P1 gate, stays in CI). Every LLM call in CI is a cassette; live-model runs happen only in the audition CLI.

## 16. Standing rules

- Read the TS comments — they are institutional memory (Neon DNS tuning, ffmpeg pinning rationale, OOM machine sizing, attempt-parking UX). Port the lessons.
- No custom retry/queue/state outside Temporal. Wanting one means the workflow is mis-shaped.
- Config owns every threshold, budget, route, and prompt version; nothing numeric is hardcoded at call sites.
- When in doubt on editorial behavior, `docs/clip-cut-architecture.md` wins; on everything else, this document wins; DECISIONS.md records the rest.
