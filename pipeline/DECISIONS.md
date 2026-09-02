# Pipeline DECISIONS.md

Deviation and decision log for [docs/pipeline-architecture.md](../docs/pipeline-architecture.md),
per that document's own rule ("Log every deviation in DECISIONS.md").

**Scope rule (2026-08-31):** pipeline-internal deviations and decisions live
here; repo-wide durable decisions still go to `AGENTS.md` the turn they are
made. Where this log and the architecture doc conflict, the newest dated
entry here wins.

---

## 2026-08-31 — Seed entries (recorded before any pipeline code)

1. **S3 keys live under the org prefix.** The architecture doc's §5 artifact
   keys (`clips/{run}/…`, `plans/{run}/…`, `indexes/…`) must be nested under
   `org/{orgId}/…` (e.g. `org/{orgId}/client/{clientId}/source/{sourceId}/pipeline/…`).
   The `/api/media/[...path]` proxy authorizes on the org prefix, and the
   review UI can only play what that proxy serves. Bare run-scoped keys would
   make every rendered clip unplayable in the panel.
2. **Postgres version.** The doc says "Postgres 16"; the repo's reality is
   the `pgvector/pgvector:pg18` dev image and Neon in deployed environments.
   Target what exists; do not install anything 16-specific.
3. **Temporal hosting** (closes the doc's `[AGENT-DECIDES]` marker, in
   stages). Dev: `temporalio/auto-setup` added to docker-compose, persisting
   into the existing pg18 container as separate `temporal` /
   `temporal_visibility` databases, on the repo's high-port convention.
   Staging: self-hosted on the VPS as a Dokploy compose stack with a **local**
   Postgres volume — Temporal persistence is too chatty for the
   Mumbai↔Singapore RTT to Neon. Temporal Cloud: revisited at cutover, when
   external users depend on uptime. Worker deploy mechanism (path-filtered
   workflow vs Dokploy service) is decided at A2.
4. **`llm_calls` payload storage.** Store hashes/references for the shared
   cached transcript prefix, not a full copy per call — a per-call copy of a
   multi-hour transcript prefix bloats the table by orders of magnitude.
5. **Parity gate demoted; cutover is per-lane dogfooding.** P4 shadow parity
   is a report, not a blocker (no external users depend on the TS output).
   P5's per-org flag flips our own org per lane as soon as that lane passes
   its M-gate. Shadow comparison runs double AI spend on compared sources —
   accepted and budgeted. `lib/intelligence/*` freezes (bugfixes only) at the
   B4 checkpoint so the baseline stops moving.
6. **Review-signal shape: OPEN — decide at the top of B1.** Options:
   workflow stays open awaiting `review_complete` (worker-versioning friction
   on deploys during days-long waits) vs run completes at `ready` and review
   starts a short finalize workflow (signal-with-start). Leaning: the second,
   for a solo operator. The UI's staleness protection (today's run-id +
   attempt + `edit_version` token) gets rebuilt on whichever shape wins.
7. **Python DB layer ports the network lesson.** IPv4 preference + explicit
   connect timeout before the first Neon connection — the Python edition of
   `tuneOutboundConnections()` (Happy Eyeballs false-`ETIMEDOUT` + AAAA
   `ENETUNREACH` incident). Required in every entrypoint that opens a
   database connection, workers included.
8. **Transcription A/B judges diarization too.** The doc's P6 scopes the
   whisperx-vs-AssemblyAI A/B to "word-timestamp quality"; speaker labels are
   load-bearing upstream (speaker system, Q&A lead-in capture, turn grids),
   so diarization quality is a first-class axis of the same A/B.
9. **Tenancy is chassis work, not integration work.** The doc's §6 schema
   carries no `organization_id` and no RLS; the repo's load-bearing rule
   applies to `pipeline.*`: org column + FORCE RLS in the creating Alembic
   migration, a script-provisioned non-superuser `mitosia_pipeline` role, a
   Python org-scope helper setting the same `app.organization_id` GUC as
   `lib/db/tenant.ts`, and `security_invoker` on the `public.v_pipeline_*`
   views. Ships in A2 with the first migration.

## 2026-08-31 — A0 scaffold conventions

10. **Toolchain shape fixed at the scaffold.** Package `clipper` (src layout,
    `uv_build` backend, `py.typed`), Python pinned by `.python-version` to
    3.12 (uv-managed interpreter). Ruff runs `select = ["ALL"]` with a small
    reasoned ignore list — parity with the app's Ultracite strictness culture
    — and pyright runs `strict`. Loosening either is a logged decision, not a
    convenience edit.
11. **The local gate's pipeline stage runs before the Docker build** (cheap
    checks first): `uv sync --frozen` → `ruff format --check` → `ruff check`
    → `pyright` → `pytest`, all inside `pipeline/`, all frozen against the
    committed lockfile. CI pytest stays cassette-only by policy from day one;
    the cassette machinery itself arrives at A2. `uv` joins ffmpeg/docker as
    a required dev-machine tool (`brew install uv`).
12. **The app image never sees `pipeline/`.** `.dockerignore` excludes it:
    the pipeline ships in its own worker image later, and the `.venv` alone
    would add ~66 MB to every app build context. Biome ignores `pipeline/`
    too (`biome.jsonc`) — ruff owns Python style.

## 2026-08-31 — A1 eval runner + gold-parity port

13. **Parity is enforced by committed snapshots, not a one-time comparison.**
    `pnpm eval:parity` runs the TS mock-mode eval flow (`lib/ai/evals/parity.ts`)
    and dumps every deterministic scorer's exact input plus the TS result to
    `pipeline/tests/parity/*.json` — one snapshot per fixture, plus a
    `synthetic.json` covering every scorer branch the mock fixtures cannot
    reach. Two suites hold the chain taut in every local-CI run:
    `tests/eval-parity-snapshot.test.ts` re-derives the snapshots so a TS
    change cannot leave them stale, and `pipeline/tests/test_parity.py`
    replays them through the ported scorers. The port matches bit-for-bit
    (same IEEE-754 operations in the same order) and byte-for-byte on issue
    strings — "within rounding" is the gate's floor, not the target. JS
    `toFixed` semantics live in `clipper.evals.jsnum` because Python's
    formatting rounds half-to-even and JS rounds half away from zero.
14. **A1 scope: scoring semantics, not capability invocation.** The Python
    runner (`clipper-eval score|verify`) computes the production thresholds
    and report over recorded scorer inputs; running lanes to produce fresh
    inputs arrives with the B-phase lanes and cassettes. The
    `moments:metrics` port covers the summary readout (acceptance rate +
    boundary-Δ, extracted to `lib/intelligence/review-metrics.ts` on the TS
    side so both languages share one spec); the `--detail` evidence view
    stays TS-only until the A2 database layer exists to feed it. The four
    grid helpers `scoreMoments` needs live in `clipper.substrate.grid` —
    the first substrate bits, re-gated byte-for-byte at A3.
15. **Wire models are camelCase-aliased pydantic** (`clipper.wire.WireModel`,
    `alias_generator=to_camel`): snapshot/view JSON stays in the repo's TS
    camelCase convention while Python code and constructor signatures stay
    snake_case. New cross-seam shapes extend `WireModel` rather than
    hand-writing aliases.
