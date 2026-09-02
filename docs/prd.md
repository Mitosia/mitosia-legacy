# Mitosia Product Requirements

**Status:** v1.0, 2026-09-02 — the feature inventory of the finished product: everything v1 (GA, gate M4) ships plus the recorded post-GA scope
**Inputs:** [tech-stack.md](tech-stack.md), [sprint-plan.md](sprint-plan.md), [pipeline-architecture.md](pipeline-architecture.md), [pipeline-implementation-plan.md](pipeline-implementation-plan.md), [clip-cut-architecture.md](clip-cut-architecture.md), [episode-to-clips.md](episode-to-clips.md), [clipping-landscape.md](clipping-landscape.md), [editor-study.md](editor-study.md), the decisions in AGENTS.md, and the 2026-09-02 Riverside audit
**Precedence:** this file records *what* the product does and for whom. Sequence lives in the sprint plan and the pipeline implementation plan; system design in the tech stack and the pipeline architecture; editorial design in the clip-cut architecture. Where one of those disagrees with this file on its own subject, it wins — and this file gets updated. Durable decisions are recorded in AGENTS.md with their dates and are not re-argued here.

## How to read this document

Every requirement carries a status tag:

| Tag | Meaning |
|---|---|
| `[built]` | On `main` today, running on staging |
| `[Sn]` | Planned in sprint n of the sprint plan (the TS app). S16, S18, billing, and the 2026-09-02 product additions are deferred until the harness roster completes |
| `[An]` `[Bn]` `[Cn]` | Planned in that phase of the pipeline implementation plan (the Python/Temporal harness) |
| `[unscheduled]` | Committed in the tech stack or specification, not yet placed in a sprint |
| `[post-GA]` | Recorded scope sequenced after gate M4 |
| `[non-goal]` | Decided against, with the date of the decision |

Sections group features the way the product is built: identity, tenancy, intake, media, transcription, intelligence, the editorial harness and its lanes, the editing and rendering studios, brand, written and visual studios, collaboration, governance, portal, publishing, analytics, recipes, billing, AI governance, security, platform, API, and onboarding. Section 29 lists the non-goals, section 30 maps sections to milestones, and section 31 states the quality bars the product is held to.

---

## 1. Product definition

### 1.1 What Mitosia is

An agency-grade AI content operations platform. Long-form sources go in — a two-hour podcast recording, a webinar, a Zoom interview, a 4K master — and come out understood, curated, produced, reviewed, approved, published, and measured, inside one governed workspace that an agency runs for many clients. The durable product is the **harness**: the content graph, the durable workflow runtime, context assembly, evaluation, and memory. No single model or renderer is the product.

### 1.2 Positioning

- **Against creator studios (Riverside, Descript).** They record and polish one creator's session. Mitosia starts after the master exists, takes it from wherever it was recorded, and serves the agency that runs weekly work for many clients under approval and rights governance. Mitosia does not record.
- **Against clipping tools (Opus Clip, Vizard, Klap, Munch).** They cherry-pick shorts with black-box selection and boundaries that "start too early, end too late" (the category's universal complaint). Mitosia's clips are grounded to the word timeline, boundary-verified by deterministic sensors and an independent-family verifier, explainable against a strategist brief, and reviewed in tooling built for the review — and Mitosia ships a coverage lane (chapters) nobody pairs with agency workflow.
- **Against coverage editors (Eddie AI).** Editor-grade rough cuts without multi-client workflow, transparency, or client approval.
- **The open flank** ([clipping-landscape.md](clipping-landscape.md) §1): multi-client agency workflow + editor-quality coverage clips + transparent, steerable selection + real boundary tooling in review. That intersection is Mitosia's declared shape.

### 1.3 Users and roles

| Side | Role | What they do |
|---|---|---|
| Agency | Owner, Admin | Organization, billing, members, clients, security settings |
| Agency | Strategist | Briefs, curation decisions, approvals, calendar, client relationship |
| Agency | Editor | Cuts, captions, renders, written assets, brand application |
| Agency | Contractor | Scoped to specific clients or projects; no billing or org visibility |
| Client | Approver | Reviews and approves under the agency's brand, never sees agency internals |
| Client | Viewer | Sees approved assets and reports only |
| Mitosia | Support | Audited, time-boxed access when a customer asks for help |

Authorization is role × scope (organization / client / brand / campaign / project / asset) × action, deny-by-default, with a permission-preview mode so an admin can see what a role will be able to do before assigning it.

### 1.4 Jobs to be done

1. Turn one long-form source into an approved, multi-format campaign for a client within a working day, with a human deciding every cut that ships.
2. Prove every asset against the source: any clip, quote, claim, chapter, or citation plays the exact range it came from.
3. Run recurring client work repeatably — the weekly podcast is set up once and every episode arrives as a correctly structured project.
4. Get client approval without exposing agency internals, and never publish anything other than the approved version.
5. Publish reliably to every platform the client uses, and learn which source moments performed.
6. Know cost and margin per client, and never pay twice for a quality failure.

### 1.5 Product principles (binding)

1. **Build the harness, buy the plumbing.** Team time goes into the content graph, workflow runtime, editorial intelligence, and brand memory; databases, auth, email, payments, OAuth, and notifications are bought.
2. **AI for judgment, deterministic software for precision.** Models plan, curate, write, and evaluate. Software validates, trims, renders, stores, authorizes, schedules, meters, and publishes. In the harness this is stated as: **the model proposes, code disposes** — models select from enumerated IDs and never emit timestamps or touch pixels.
3. **Every provider is replaceable.** Transcription, text models, embeddings, renderers, voice, and social APIs sit behind adapters. The domain layer never imports a provider SDK.
4. **Non-destructive by design.** Edits are versioned specifications; renders are reproducible functions of (source, spec, template version).
5. **Tenant isolation is structural.** Organization scoping on every row, storage prefix, queue payload, vector, and cache key, enforced by Postgres row-level security and tested by cross-tenant probes — never by code review.
6. **Unit economics are a feature.** Every metered thing writes to the ledger in the sprint it ships; budgets are breakers, not reports; checkpoints mean a retry re-pays zero tokens.
7. **No numeric editorial enforcement in prompts.** Prompts describe what a chapter or moment *is*; counts and durations are enforced by sensors and reconcilers after generation, and outliers surface as flags for a human.
8. **Verification is external and independent.** Generator and evaluator are different seats; the final verifier is a different model family; reviewers see rendered evidence, never the proposer's claims; ungrounded output does not ship.
9. **Failure is cheap and progress is durable.** Every model decision is checkpointed; deterministic failures never retry; transient ones retry with backoff.
10. **No virality theater.** Scores are editorial judgment, never performance prediction, until real distribution data exists to calibrate against.
11. **Humans decide; the system explains.** Every automated proposal is a proposal. Accept, shortlist, reject, restore, nudge, and merge are first-class, audited actions, and the metrics that matter are human acceptance and boundary-adjustment magnitude.

### 1.6 North-star metrics

| Metric | Bar |
|---|---|
| Moment acceptance on a fresh source, minor or no boundary change | ≥ 70% (gate M1; measured 18% before the cutting room redesign, next round pending) |
| Median boundary adjustment by the reviewer | Trending toward zero seconds |
| Reviewer-agent agreement with the human reviewer | The 75–80% band, the human-human ceiling; never tuned higher |
| Cost per source-hour per lane | Within the target set per sprint (measured 2026-08-30 baseline: $0.43–1.01 segments, $0.43–0.97 discovery) |
| Publishing | Zero duplicate posts; success rate at target for two consecutive weeks (gate M3) |
| Activation | A cold-start agency reaches its first curated moment portfolio without support contact (gate M4) |

---

## 2. Identity and authentication

- Email and password sign-up and sign-in, sessions, and organization membership on Better Auth with the auth schema generated by its CLI. `[built]`
- Password recovery that is privacy-preserving and fails closed: one-hour single-use tokens, every session revoked on a successful reset, no disclosure of whether an email exists or whether delivery succeeded, delivery through a background task so provider latency is not a timing oracle. `[built]`
- Organization invitations with roles v1 (owner, admin, member, contractor stub). `[built]`
- Client IP taken from Cloudflare's header behind the proxy, so rate limits and audit entries record the real address. `[built]`
- Magic-link sign-in, passkeys, and TOTP two-factor authentication through Better Auth plugins. `[unscheduled]`
- Single sign-on (OIDC and SAML) and SCIM directory sync through WorkOS when enterprise deals require it; Better Auth stays the session layer. `[post-GA]`
- Guest and review links: signed, expiring, scope-limited tokens (view, comment, approve) with watermark flags, for external reviewers who never get an account. `[S15]` `[S16]`
- Support access: time-boxed, customer-granted, and written to the audit log. `[S22]`

## 3. Multi-tenancy, hierarchy, authorization, audit

- Hierarchy: organization → clients → brands → campaigns → projects → sources and assets, with a context switcher that scopes every list and action. `[built]`
- Row-level security on every tenant-owned table, forced, created in the same migration as the table, with an automated cross-tenant isolation suite that grows with the schema and runs in the PR gate. `[built]`
- The application database role is never a superuser or table owner; it is provisioned by script that asserts the role cannot bypass RLS. The pipeline gets its own non-superuser role and the same organization GUC. `[built]` `[A2]`
- Storage keys are prefixed `org/{orgId}/client/{clientId}/…`, and that prefix is the authorization boundary for every read, including the media proxy and pipeline artifacts. `[built]`
- Foreign keys never trust user-supplied parent ids: parents are re-read inside the organization scope before a child row is written. `[built]`
- Authorization policy package: role × scope × action ability checks, deny-by-default, permission preview; graduation to a relationship-based engine (OpenFGA or SpiceDB) when custom roles and inheritance exceptions outgrow tables. `[S15]` `[post-GA]`
- Append-only audit log for sensitive actions: auth and permission changes, curation decisions and boundary edits, approvals, publishes, exports, support access — with an export stream, and WorkOS audit-log export at the enterprise tier. `[built]` `[S15]` `[post-GA]`
- Rights and consent as first-class tables that can block generation, export, or publication independently of workflow status: talent releases, music licenses, per-speaker voice consent. `[S17]` `[S21]`
- Per-tenant AI data governance: provider allowlist, no-training flags, regional routing configuration, and a redaction pass before model calls where policy requires. `[unscheduled]`

## 4. Source intake

- Resumable multipart upload direct to object storage (Uppy + AWS S3 multipart against R2, MinIO in development), with pause, retry, and resume across browser sessions. Upload identity lives only in Uppy file state; ghosts over 10 MB are re-selected and reconnect to their upload. `[built]`
- Server-side adoption of an abandoned upload of the same file, so a dismissed recovery card or a switched browser never strands parts under a duplicate row. `[built]`
- Idle-upload reaping after the resume window with storage-side multipart abort, and an R2 abort rule as the backstop. `[built]`
- Source records with lifecycle states (uploading → uploaded → processing → ready | failed), metadata, and a project page that reflects them. `[built]`
- **Upload-first policy.** The customer's raw material is the master; a platform link hands the pipeline a re-compressed derivative. Link ingest is a connector feature, not the primary path. `[built, decision 2026-08-24]`
- **Multi-track source groups.** A Riverside, Zoom, Squadcast, or Descript export ingests as one source holding per-speaker audio and video tracks plus the mix. Tracks are aligned to the mix at ingest and diarization binds to track identity, which unlocks per-speaker mute, per-track audio cleanup, and track-driven layout switching without computer vision. `[S10]`
- Import connectors behind one interface: direct file URL, Google Drive, Dropbox, Zoom cloud recordings, Vimeo via its owner-authenticated download API, and recording-studio exports where an owner-authenticated path exists. Fetched sources land in storage under the organization prefix and pass through the same scan and ingest pipeline as uploads. `[S16]`
- Malware scanning (ClamAV) on every untrusted-input path: portal uploads and connector fetches. `[S16]`
- Client intake and request forms in the portal, feeding a project directly. `[S16]`
- **Batch intake with per-client queues:** bulk upload and bulk connector import, per-client concurrency keys on the durable runtime, a queue view with truthful progress and no invented ETAs, and recipe defaults applied on arrival. `[S16]`
- **No YouTube extraction.** There is no official download API even for channel owners; extraction violates YouTube's terms and breaks on datacenter IPs. The support answer is "download from YouTube Studio and upload". `[non-goal, 2026-08-24]`

## 5. Media pipeline

- Durable ingest workflow: probe and validate → HLS proxy ladder → thumbnails → waveform peaks → audio extract → shot grid, with an in-process development fallback selected by the absence of the worker key. `[built]`
- Rendition ladder following platform practice: native top rung up to 1080p with capped CRF, 720p and 360p proxies, two-second keyframes, and an I-frame-only companion playlist per rung for keyframe-only scrubbing and filmstrips. `[built]`
- Every transcode is duration-verified before a source can become ready, because ffmpeg treats a dropped connection as end-of-file and exits cleanly with a truncated output; remote inputs always go through the reconnect-hardened input arguments. `[built]`
- Waveform peaks span the media duration (silent padding when audio ends early) with samples-per-pixel scaled to the duration, so the overview timeline and the video timeline never drift. `[built]`
- Progress reporting on the long transcode step, a stalled-ingest reaper for hard-killed workers, and best-effort progress writes that can never fail a transcode. `[built]`
- One ffmpeg minor (8.1.x) pinned in three places — the version check script, the Alpine release in the Dockerfile, and the mirrored static build for the worker image — with a check that fails whichever side drifts. `[built]`
- Every artifact row carries its size, and the storage ledger entry is summed from those rows inside the finalize transaction. `[built]`
- Media reaches the browser only through an authenticated same-origin streaming proxy that rejects keys outside the caller's active organization; no public or presigned URLs in the client. Signed, expiring CDN URLs arrive with client delivery. `[built]` `[S18]`
- Player: Video.js v10 React with hls.js, peaks.js waveform bound through a passive adapter, top-rung start quality, and a single range-playback instance that plays any span and pauses at its out-point. `[built]`
- Two-pane source workspace: sticky player on the left, tabbed review panels on the right, so reviewing a clip never requires scrolling back to the video. `[built]`
- Program cuts come from the original master with duration verification; stream-copy when both cuts sit within 100 ms of keyframes, otherwise a re-encode. All ffmpeg strings live in the render and sensor wrappers only. `[B1]`
- Storage lifecycle tiers (hot, archive, cold) per client with retention policy. `[post-GA]`

## 6. Transcription and speaker intelligence

- Provider seam with Deepgram (nova-3, diarization, smart format, language detection) as primary, AssemblyAI behind the same interface, and a deterministic mock provider for tests. Adapters parse the provider's raw response with Mitosia's own schema so a contract change is a loud alarm. `[built]`
- Transcription is a follow-on job with its own lifecycle, silence-based reaper, and retry; a provider outage cannot fail a finished ingest. `[built]`
- Canonical transcript JSON in storage with integer-millisecond words, confidence, and speaker ids; Postgres holds the lifecycle and an append-only revision ledger. Revisions are reserved for changes to the words. `[built]`
- Transcript viewer with click-to-seek, search, speaker naming, and low-confidence highlighting; transcript corrections that create revisions; SRT and VTT export built on speaker-aware cue segmentation. `[built]`
- Speaker labels: manual rename and merge as the permanent human override, with AI-suggested names and same-person merges delivered as confirmed suggestions, never silent auto-apply. `[built]`
- Metering: transcription minutes per attempt and storage bytes per revision. `[built]`
- Punctuation-quality check before planning, because the sentence grid depends on it. `[A3]`
- Transcription ownership A/B: WhisperX on Modal against the hosted providers, judged on word-timestamp quality, diarization quality, cost, and throughput; placed between editorial harnesses, never during one. `[C4]`
- Transcription in the languages the providers support, with language shown and overridable per source. `[built]` `[unscheduled]`

## 7. Source intelligence

- Source analysis: executive summary, chapters, topics, entities, rendered as a source map. `[built]`
- Extraction passes: quotes, stories, claims, and Q&A over one shared cached transcript prefix; CTAs arrive with their consumer. Automatic chain runs once per source; every re-run is a human action because it re-spends tokens. `[built]` `[S11]`
- **The grounding aligner is the provenance gate.** Every claimed-verbatim text is fuzzy-matched to the word timeline near its claimed range, the range is snapped to matched word boundaries so it is playable and exact, and ungrounded rows never surface. Claim classification is the aligner's byproduct (`direct_quote` / `paraphrase`); model-judged `inference` / `unsupported` arrive with the written studio. `[built]` `[S11]`
- Embeddings (voyage-4, 1024 dimensions, single provider by design) over deterministic speaker-turn chunks in pgvector; an index lifecycle with its own reaper that re-embeds on every new transcript revision. `[built]`
- Source Q&A: top-k retrieval within the source, every citation clamped to a retrieved chunk before it persists, `answerable=false` as a first-class outcome, question history, and a failed-index card with a retry button. `[built]`
- Semantic search within a source. `[built]`
- Highlights panel: one list with kind filters, playable ranges. `[built]`
- **Episode package:** show notes, YouTube chapters with timestamps, title and description variants, keywords, pull quotes, and guest bios, every sentence grounded to a range and checked by the brand evaluator. `[S11]`
- **Cross-source intelligence v1:** client-wide semantic search, twin detection across sources ("this guest said the same thing in episode 12"), and cross-episode guest profiles. `[S12]`
- Archive mining depth: campaign-level themes across a client's whole library, evergreen resurfacing, cross-client (never cross-organization) pattern reports. `[post-GA]`

## 8. Editorial harness platform

The harness is the product. Every editing workflow follows the same five-layer recipe: **structured perception → declarative spec over enumerated IDs → deterministic execution → computable sensors → separate evaluator → fixture flywheel.** Per workflow, only the spec shape and the sensor set change.

- Chassis: Python 3.12 on Temporal, a `pipeline` schema in the shared Postgres, checkpointed passes keyed on transcript revision + pass + prompt version + seat route + params, so replays and human retries re-pay zero tokens. `[A2]`
- Economics layer built before any real prompt runs: transient-versus-deterministic error taxonomy (deterministic failures are terminal on attempt one), a per-run budget derived from a per-source-hour budget and checked before every model call (breach completes the run with partials, raising the budget is an explicit signal), ceilings on dispatches, failovers, repairs, and revisions, persisted failure evidence, and a cost-per-source-hour number on every run. `[A2]`
- LLM seam: one native structured call per operation validated locally against a strict portable wire schema, ordered failover halted after two independent models fail the same local validation, one bounded error-directed repair, family exclusion for judge and verifier seats, cached shared prefix with cache reads verified in telemetry, provider pinning for open-weight models, and every call logged with seat, models attempted, cache statistics, and cost. `[built in TS]` `[A2]`
- Seat routing decided by cost-per-correct on fixtures, re-run when the market moves; one model per seat in production, the pool exists for failover and audition. `[A2]` `[C, standing]`
- Substrate: word timeline → sentence grid, pause boundaries, speaker-turn grid, question annotation, paragraph grouping, shot-change grid; coarse and fine renderings with stable enumerated IDs. Byte-identical to the TS grids on recorded sources. `[built in TS]` `[A3]`
- Seam with the app: Temporal is the API (start, query, signal); the app reads `security_invoker` views and never writes pipeline tables; the pipeline writes the shared usage ledger with the same correlation-id convention; artifacts are immutable under organization-prefixed keys. `[B1]`
- Eval runner with the ported scorers and a permanent parity chain against the TS implementation; boundary-F1, WindowDiff, chapter-count delta, temporal IoU, precision and recall at IoU 0.5, evaluator pass rate, and cost-per-correct per seat and model. CI fails a boundary-F1 drop over 0.05 and runs the chaos test (kill a worker mid-run, resume with zero repeated calls). `[A1 built]` `[A2]`
- Fixture flywheel: every approve-with-edit in review writes a fixture automatically. `[B1]`
- Per-organization cutover flag; Mitosia's own organization is the first to flip. TS intelligence freezes at the parity checkpoint and retires after the roster. `[B3]` `[B4]` `[Phase D]`
- Live generation progress in the review panel (stage rail, truthful step progress, previous result stays visible). `[deferred nice-to-have]`

## 9. Clip lanes: moments and segments

Two lanes share one cutting room. **Moments** is the peak lane (standalone highlights); **Segments** is the coverage lane (an exact-cover chapter partition with keep and drop decisions). Both are built and on by default in the TS app and are the first two lanes on the Python chassis.

- Director brief: one durable episode brief per source and transcript revision — spine, marquee arcs, tone, drop territories — required for segments and fail-closed when invalid. `[built]` `[B1]`
- Rough passes propose paragraph-ID regions over the coarse rendering with a table-of-contents-first contract and a drop-reason taxonomy; a global Reconciler turns segment boundaries from mandatory cuts into hypotheses it can remove; exact-cover validation rejects omission, duplication, reordering, or keep/drop mixing and falls back atomically. `[built]` `[B1]`
- Per-clip Cutter over a local sentence-ID window with the in ≤ payoff ≤ out invariant, lead-in capture of the provoking question, lead-out on the payoff sentence, and a could-not-find escape; boundary-type semantics for keep/drop transitions. `[built]` `[B1]`
- Deterministic gauntlet: snap to the sentence grid with capped growth and pause fallback, lead-in capture across a different speaker's short setup, lead-out trim, stale-open detection, pause-air trimming, shot-snap, pairwise overlap and duration sanity, all recorded as flags. `[built]` `[B1]`
- Grounding through the aligner (anchor text must align inside the final range or the row never surfaces) and two-pass dedupe (range IoU, then chunk-vector cosine for the same story told twice). `[built]`
- Composite score (hook, insight, relevance, comprehensibility; risk is a flag, never a demerit) and relative outlier flags — never quotas, never auto-demotion. `[built]`
- Cold-context Reviewer per surviving clip on a 0–1–2 rubric with one fix from a constrained vocabulary, then one bounded revision re-cut; verdicts inform, never gate. `[built]`
- Publisher gate: one declarative exact-cover edit of the whole post-Cutter plan, pure-code validation, then verification by a model family excluded from the editor's, with at most one editor revision. `[built]` `[B1]`
- Rendered outputs: segments keep the source aspect with a sidecar caption file; moments render 9:16 with burned captions; `chapters.json` and a YouTube description with timestamps at finalize. Post-render file battery: black and frozen frames at the edges, two-pass loudness, duration against the EDL, onset clearance, caption sync. `[B1]` `[B2]`
- Shared-boundary rule for adjacent segments: one cut point inside a shared silence gap; trimmed dead air belongs to neither; any boundary edit cascades to the neighbor and re-runs both clips' sensors. `[B1]`
- **Steerable discovery:** a per-run strategist brief composed into the Director pass, stored on the run and audited, steering selection only; a brief-adherence score surfaces as a flag. `[S7]` `[Phase B]`
- Human review: accept, shortlist, reject with a reason, boundary nudges along the sentence grid, restore a proposed drop, merge adjacent keeps, edit-version locking with stale-confirmation protection, and every mutation in the audit log. A failed refresh preserves the previous committed result. `[built]`
- Planning is a button, never a chain: the segment plan heads toward spend-gated rendering, so the strategist chooses when. Discovery chains once from extraction; every re-run is a human action. `[built]`
- Metrics readout: acceptance rate and boundary-adjustment magnitude per source and overall, plus a boundary post-mortem view. `[built]`

## 10. Harness roster

| Lane | What it does | Spec | Sensors (representative) | Status |
|---|---|---|---|---|
| Tighten — silence, filler, tangent, smooth cuts | Rough-cut cleanup inside kept material: silences and fillers deleted from a pause map and filler lexicon with the model judging only ambiguous cases; tangent, ramble, false-start, and told-twice trims proposed with a reason and restorable; jump cuts concealed by alternating punch-in, never across a shot boundary | Word/gap and sentence-ID deletion list on the clip EDL | No clipped word onsets, pace within a WPM band, max consecutive jump cuts, payoff sentence survives, remaining text sentence-complete | `[C1]` |
| Audio enhancement | Noise and reverb cleanup and loudness per track behind a provider seam, with before/after evidence | Declarative enhancement chain per track | −14 LUFS ±1.5, no clipped onsets, speech-band energy preserved, noise-floor drop at target | `[C1]` `[S9]` |
| Mid-roll ad insertion | Segment boundaries re-scored for topic completion and distance from narrative peaks | Ranked insertion points | Snap to pause, minimum spacing | `[C2]` |
| Captions | Subtitle segments from word timings with speaker-aware breaks and style presets | Segments with line breaks | Chars/sec ≤ 17, line length ≤ 42, sync drift, shot-change crossing rules | `[S8]` `[C3]` |
| Caption translation | Translation with the brand glossary and translation memory | Translated segments | Back-translation-consistency judge, same broadcast sensors | `[C3]` |
| Dubbing groundwork and word-level voice fixes | TTS/voice seam with duration-fit sensors; consent-gated fix of a misspoken word or number in the speaker's own voice, refused without a consent row, flagged as synthetic in spec and evidence report | Word-range replacement | Duration fit ±10%, consent present, synthetic range flagged | `[C3]` `[S21]` |
| Transcription ownership A/B | WhisperX on Modal against hosted providers | — | Word-timestamp and diarization quality, cost, throughput | `[C4]` |
| Smart reframe | 16:9 → 9:16 subject tracking from face and saliency tracks | Crop keyframe path, never per-frame crops | Subject-in-frame ratio, crop velocity and acceleration caps, no pan across a shot boundary | `[C5]` `[S10]` |
| Multicam auto-switching | Camera cut list from track activity (source groups) with face presence as fallback | `{time, cam_id}` keyed to word indices | Min shot length, no cut mid-word, active speaker on camera ≥ 90%, max time on one camera | `[C6]` `[S10]` |
| Best-take assembly | Script-to-take alignment for scripted content | `{script_line → take_id, word_range}` | Full script coverage, per-line WER, audio continuity at joins | `[C7]` |
| Trailer and teaser | Ordered sparse segments with role labels; the evaluator carries most weight | Sparse segment list with roles | No spoiler segment, hook within 3 s, each segment standalone | `[C8]` |

Each lane ships with its review surface, its Playwright coverage, evals green, an M-style review round on fresh sources, and cost within target before it is called done.

## 11. Video editing studio

- Versioned JSON edit spec: in and out ranges, layers, caption track reference, template reference, crop keyframes, audio chain. The timeline and the transcript are two views over one spec. `[S8]`
- Transcript-based cutting: remove ranges, filler words, and false starts by editing text; restore anything. Pacing control for silence removal. `[S8]` `[C1]`
- **Non-contiguous assembled clips:** an ordered set of grounded spans in one spec — a question joined to its later answer, a montage of three takes on one idea — with joins rendered in both views and checked by the file sensors. `[S8]`
- Tangent, ramble, and false-start proposals from the tighten lane shown as restorable suggestions with reasons, never auto-applied. `[S8]` `[C1]`
- Timeline v1: a canvas-drawn track area (clips, waveform, filmstrip, playhead, snap lines) with DOM chrome, frame-accurate trim, virtualization that stays O(visible) at any zoom, keyframe-only filmstrip decode through the I-frame playlists. `[S8]`
- Caption model: transcript reference + segmentation parameters + style preset in the spec; cues, SRT, and VTT derived, never materialized as clips. `[S8]`
- Browser preview through the Remotion Player over the HLS proxy, driven by the same spec that renders, so preview and render cannot drift. `[S8]`
- History and undo, autosave, conflict-safe persistence. `[S8]`
- Media access layer on MediaBunny for frame-accurate seeking and keyframe-only decode in the browser. `[S8]`
- Manual crop override editor with platform safe-zone overlays; aspect variants inherit from a base edit. `[S10]`
- Per-speaker mute and per-track cleanup controls when a source group exists. `[S10]`

## 12. Rendering and export

- Render tiers: instant browser preview, watermarked low-bitrate review render, platform-ready final, archive master; render cache keyed by spec hash; golden-fixture determinism tests. `[S9]`
- Remotion brand templates as versioned React components: captions, titles, logo, progress bar, lower thirds, audiograms. `[S9]` `[S12]`
- ffmpeg cut, aspect conversion, and two-pass loudness normalization driven by the spec; all ffmpeg strings confined to the render wrappers. `[S9]` `[B1]`
- Audio enhancement as a metered render layer with a before/after preview and one ledger entry per render. `[S9]`
- Deterministic smooth cuts as template behaviour gated by the jump-cut sensor. `[S9]`
- Multilingual caption tracks through the same templates. `[S9]` `[C3]`
- **NLE handoff:** FCPXML, EDL, and Premiere XML export of an approved spec, multi-span aware, with the evidence manifest attached. `[S9]`
- Audiograms for audio-only sources in every aspect variant. `[S12]`
- Aspect variants (9:16, 1:1, 16:9) from one edit, with auto crop keyframes from the reframe harness and manual correction. `[S10]` `[C5]`
- Render queue UI with status, retry, and cost. `[S9]`
- Post-render file sensors on every rendered clip (edges, loudness, duration, onsets, caption sync); sensor failures auto-fix where defined and otherwise route to review. `[B1]`
- Export packages: ZIP, manifest, evidence report, and storage delivery. `[S18]`
- Multi-codec delivery ladders (VP9, AV1) and cellular rungs for client-facing playback. `[S18]`

## 13. Brand intelligence and memory

- Brand profile per brand: visual kit (logos, colors, fonts), voice and tone, vocabulary, approved and prohibited claims, examples; versioned with approval states. `[S7]`
- Brand packs in context assembly with versioned snapshots and per-item provenance, so every generation records which brand context it used. `[S4 built for source packs]` `[S7]`
- Brand-check evaluator: terminology, prohibited phrases, claim status, voice adherence, applied to written and packaged output. `[S7]` `[S11]`
- Brand memory suggestions classified from reviewer feedback, with approve, reject, and expire. `[S21]`
- Per-client voice learned from approved outputs rather than from a style prompt alone — the agency's own accepted assets are the examples. `[S21]`
- Per-client editing profiles: a reviewed editing workflow archived as a reusable recipe of cut preferences and packaging style. `[post-GA]`

## 14. Written content studio

- Tiptap editor with grounded generation: LinkedIn posts, X threads, newsletter sections; sentence-level evidence links to transcript ranges; unsupported-claim flags. `[S11]`
- Hook variants, platform length rules, and realistic platform previews. `[S11]`
- Brand voice checks wired to the evaluator. `[S11]`
- Episode package as a written deliverable (section 7). `[S11]`
- Suggested edits, track changes, comments, and mentions on the collaborative document. `[S11]` `[S14]`
- Structured `@` references to moments, brand rules, and assets inside prompts and documents. `[S11]`

## 15. Static visuals, asset families, library

- Variant and asset-family model with a lineage panel: every asset traces to its source moment and its context snapshot. `[S12]`
- Asset library with filters, search, statuses, and versions; cross-source search over a client's library. `[S12]`
- Quote cards through Satori templates; carousel copy output. `[S12]`
- Audiograms (section 12). `[S12]`
- Design studio decision: Polotno SDK spike concluded and recorded; full Canva-grade template editing follows the decision. `[S12]` `[post-GA]`
- Image generation and background removal behind the provider seam for visual variants. `[post-GA]`

## 16. Campaign canvas

- A node-graph canvas (React Flow) auto-generated from the project: sources → moments → assets → reviews, with typed nodes carrying status, thumbnails, and counters, typed edges, and an inspector panel. `[S13]`
- Deterministic lane auto-layout with synchronized table and board views of the same graph. `[S13]`
- The canvas renders the content graph in Postgres; it never owns approval or lineage state. `[S13]`

## 17. Collaboration and notifications

- Comments on assets, transcript ranges, and video frames; mentions; threads. `[S14]`
- Tasks with assignment, status, and due dates; project activity feed. `[S14]`
- Presence and live cursors on canvas and documents (Yjs through Liveblocks, self-hosted Hocuspocus as the graduation). `[S14]`
- Unified notification inbox, preferences, batching, and email digests through Resend; notification infrastructure bought (Knock or Novu). `[S14]`
- Mobile and browser push through the companion app. `[post-GA]`

## 18. Review and approval engine

- Review requests with stages (internal → client), sequential or parallel, required approvers. `[S15]`
- Version-pinned approvals; material edits invalidate per policy; an immutable approval audit trail. An approved asset cannot be edited or published as anything other than its approved version — demonstrated by adversarial tests, not asserted. `[S15]`
- Proofing surfaces: frame- and range-accurate video comments, text selections, image regions. `[S15]`
- Revision rounds counted against the entitlement model. `[S15]` `[S19]`
- Publishing preflight re-verifies approval state independently of the workflow. `[S17]`

## 19. Client portal and delivery

- White-label portal: logo, colors, and a custom domain per agency through Cloudflare for SaaS with managed certificates. `[S16]`
- Client roles with simplified review (approve, request changes) and a source-evidence view that plays the range behind any asset. `[S16]`
- Approved-asset library and delivery downloads; intake and request forms. `[S16]`
- Internal-only versus client-visible comment scoping enforced. `[S16]`
- Export packages, storage delivery, signed expiring URLs, and watermarked review renders. `[S18]`
- Branded scheduled client reports delivered to the portal. `[S20]`

## 20. Publishing and scheduling

- OAuth and token lifecycle through Nango; account health and reauthorization prompts. `[S17]`
- Wave 1 platforms: LinkedIn, X, YouTube. Wave 2 as app reviews land: Instagram/Meta, TikTok. Later: podcast/RSS, newsletter, CMS, DAM. Applications filed at M2 because reviews take months. `[S17]` `[S21]` `[post-GA]`
- Destination-specific composer: copy, media, thumbnail, first comment, links; a common interface that does not erase platform differences. `[S17]`
- Preflight: approval state, format, rights, schedule conflicts. `[S17]`
- Durable idempotent publish jobs with receipts, remote ids, and post-publish verification; zero duplicates under forced errors. `[S17]`
- Content calendar with production, approval, and publication events, drag to reschedule, timezone-correct; approval-gated scheduling and queues; failure dashboards. `[S18]`
- **No aggregator.** Publishing adapters are in-house per platform because an aggregator becomes the product's ceiling. `[non-goal, tech-stack §12]`

## 21. Analytics and reporting

- Metrics collection through the same platform adapters into a normalized analytics layer with raw and normalized retention. `[S20]`
- Lineage dashboards: publication → asset → moment → source, with campaign and client views; which source moments produced the best-performing posts. `[S20]`
- Branded scheduled client report v1. `[S20]`
- Warehouse graduation (ClickHouse) when social time series and event volume demand it. `[post-GA]`
- Experiments framework (hook and variant tests with real outcome data). `[post-GA]`
- Agency operations and profitability reporting depth: bill-back, time tracking, margin per client. `[post-GA]`

## 22. Recipes, automation, learning loop

- Recipes v1: deliverable set, defaults, owners, approval chain; one-click project generation; a returning weekly client is set up once. `[S21]`
- Moment-ranking calibration from acceptance and performance data; the accept/ship decision is the learning signal from day one. `[S21]`
- Brand memory suggestions with approve, reject, and expire (section 13). `[S21]`
- Automation builder: triggers, conditions, actions on the same durable runtime as recipes; inbound webhooks and schedules. `[post-GA]`
- Template and recipe marketplace. `[post-GA]`

## 23. Billing, entitlements, usage economics

- Append-only usage ledger with organization, client, brand, project, job, and user dimensions; idempotent writers via unique correlation ids; corrections as compensating entries; UPDATE and DELETE denied by policy shape. `[built]`
- Metered today: storage bytes, processing minutes, transcription minutes, AI tokens with cost attribution per task and model, embeddings. Cost readout per task, per model, attempts-per-call amplification, cache-read share, and dollars per source-hour per run. `[built]`
- Per-run AI spend budget checked before every attempt in the TS system; per-source-hour budget breaker with partial completion in the pipeline. `[built]` `[A2]`
- Merchant-of-record payments (Dodo Payments) for plans, subscription lifecycle, webhooks, and customer portal; India-friendly by design, with Paddle or a US entity as the enterprise second rail. `[S19]` `[post-GA]`
- Entitlement engine: seats, clients, source hours, render minutes, feature flags, period pools, rollover and overage rules, real-time checks, explain-why-blocked UX. `[S19]`
- Pre-action estimates and overage prompts; usage dashboard per organization and client. `[S19]`
- **Fair-billing rule:** re-runs and quality failures must never feel like paying twice — checkpoints re-pay zero tokens, failed refreshes keep the previous result, and credits are never burned on output the human rejected. `[built]` `[A2]` `[S19]`
- Client bill-back and profitability reports over the ledger. `[post-GA]`

## 24. AI platform governance

- One gateway (OpenRouter) for text generation with explicit, pinned, ordered model pools per capability owned by Mitosia; the gateway routes infrastructure, never editorial choice. Zero-data-retention routing, provider data collection denied, strict JSON schema, parameter support required, syntax-only response healing, hashed sticky-session ids, and the winning and attempted models recorded on every call. `[built]`
- Structured output as a two-contract compiler: a portable wire schema for the provider and the full local parser as the acceptance gate; deterministic invariants after parsing; one bounded corrective call; invalid output never reaches application state. `[built]`
- Cost containment as code: every validator invariant stated in the instructions it grades; failover halted after two independent models fail the same local validation; a run budget enforced before each attempt; bounded validation-failure logging. `[built]`
- Transport-verified model pools: any new vendor is probed with the full request shape before seating; a cheap bench (DeepSeek, Gemini Flash, GLM, MiniMax) is seated as fallback only, and promotion to a first slot requires a real-source audition. `[built]`
- Embeddings direct to Voyage behind an in-house seam, single provider by design. `[built]`
- Telemetry: Langfuse tracing on app and worker with production spans metadata-only, so customer transcripts and model output never leave the processing path for observability; golden fixtures are the content-debugging surface. `[built]`
- Golden evals per capability with deterministic scorers and key-gated LLM judges, run before any prompt promotion; deliberately outside the per-PR gate. `[built]`
- Prompt registry with versioned prompts; prompts change only through it. `[built in code]` `[unscheduled as a UI]`
- Reviewer calibration harness modeled on the published methodology: anchor set with rerun-stability gating, failure-mode catalog as regression tests, agreement targeted at the human-human band. `[unscheduled]`
- Per-tenant governance: provider allowlist, no-training flags, regional routing, redaction pass, embeddings and caches deleted with the source. `[unscheduled]`

## 25. Security, privacy, compliance

- RLS everywhere with the isolation suite in the PR gate; non-superuser application and pipeline roles. `[built]` `[A2]`
- User-facing hostnames behind Cloudflare with the origin locked to Cloudflare's ranges, Full (strict) TLS, per-host and wildcard certificates from two resolvers, the admin panel behind Cloudflare Access. `[built]`
- Secrets per environment, injected at runtime, never in images or the repository; shared vault (Infisical) across app, workers, and CI; per-tenant integration credentials encrypted with wrapped keys. `[built]` `[S17]`
- Privacy-preserving password recovery (section 2). `[built]`
- Signed short-lived media URLs, watermarked review renders, download controls. `[S18]`
- Rights and consent blocking generation, export, and publish. `[S17]` `[S21]`
- Malware scanning on untrusted input. `[S16]`
- Hardening pass: audit coverage review, signed-URL and rights-blocking audit, rate limits, load tests, incident runbooks, status page, alerting SLOs, backup restore drill. `[S22]`
- SOC 2 posture with Vanta once the first enterprise conversation begins; data residency options and audit-log export at the enterprise tier. `[post-GA]`

## 26. Platform, infrastructure, delivery

- Hosting: Hostinger VPS with Dokploy, staging tracking `main` and production tracking the `production` branch promoted by fast-forward only; Neon Postgres per environment in separate projects; Cloudflare R2 for storage; Trigger.dev for durable app jobs; Modal for GPU and heavy compute; Temporal for the pipeline. `[built]` `[A2]`
- Deployed environments migrate themselves at container start under an advisory lock; a failed migration fails the deploy loudly. `[built]`
- Exact-commit local validation gate while the project has one committer: frozen install, lint, ffmpeg pin, unit and RLS tests, the pipeline stage, full production Docker build, host build, production hydration e2e, and the dev e2e suite, attested per SHA and required by branch protection. Independent hosted validation returns before a second committer. `[built]`
- Path-filtered worker deploys on merge; the app image and the worker image are two deploy targets. `[built]`
- Observability: error tracking (Sentry), traces and logs (OpenTelemetry to Axiom), product analytics and feature flags (PostHog), uptime and status (BetterStack). `[S22]` `[unscheduled]`
- Second worker box when queue depth demands it; self-hosted Trigger.dev as the cost graduation. `[post-GA]`
- Polyglot monorepo: the Next.js app at the root and the Python pipeline under `pipeline/`, joined only by Temporal, SQL views, the ledger, and organization-prefixed storage keys. `[built]`

## 27. Public API, webhooks, integrations, enterprise

- Versioned public API (Hono + OpenAPI) with idempotency keys, scoped keys, and pagination, over the same service layer as the app. `[post-GA]`
- Outbound webhooks with signing, retries, and replay (Svix). `[post-GA]`
- Developer portal and agent access (an MCP surface over the public API) — recorded as a candidate given the market's move toward agent-addressable clipping. `[post-GA, candidate]`
- Enterprise pack: SSO and SCIM, residency, audit export, custom roles at scale. `[post-GA]`
- Additional publishing and intake connectors as design partners need them. `[post-GA]`

## 28. Onboarding, localization, accessibility, mobile

- Organization onboarding wizard: first client, brand intake, first recipe, sample project. `[S23]`
- Empty states, guided tours, help docs, brand-kit and asset import basics. `[S23]`
- Accessibility pass on core flows; localization with RTL verified. `[S23]`
- Pricing and packaging, trial flow, marketing site aligned to positioning. `[S24]`
- Companion mobile app (Expo) for approvals, notifications, and review on the go. `[post-GA]`

## 29. Non-goals

| Not building | Why | Decided |
|---|---|---|
| Recording | A different company; Mitosia starts after the master exists | 2026-09-02 |
| Eye-contact and gaze correction | Creator polish with no agency pull; a bought model if design partners ever ask | 2026-09-02 |
| Generative B-roll | Unlicensed synthetic footage under a client's brand is a rights liability and off-thesis; grounded B-roll from the client's library or licensed stock, rights-tracked, is the post-GA version | 2026-09-02 |
| YouTube extraction | No official download API; extraction violates terms and breaks on datacenter IPs | 2026-08-24 |
| Virality scores without behavioral ground truth | Zero-shot models barely beat random at predicting engagement; scores are editorial judgment until real distribution data exists | 2026-08-26 |
| Aggregator publishing | An aggregator becomes the product's ceiling | tech-stack §12 |
| Free-running agents | Capabilities are bounded model calls inside a deterministic graph; frameworks own control flow, and a harness must own it | 2026-08-31 |
| Convex, tRPC, a graph database | Postgres with RLS, one typed service layer, recursive CTEs over a typed edge table | tech-stack §3, §9 |

## 30. Release map

| Gate | After | Sections that must hold |
|---|---|---|
| M0 — Walking skeleton | S3 | 2, 3, 4 (upload), 5, 6 — **passed 2026-08-23** |
| M1 — Magic moment | S6 | 7, 8 (TS), 9 — **failed 2026-08-28 on boundaries; cutting room rebuilt; re-measurement pending** |
| Phase A–B (pipeline) | — | 8 on Python, 9 on Python with review surfaces, dogfood cutover |
| Phase C (roster) | — | 10 |
| M2 — Private alpha | S11 | 7 (episode package), 11, 12, 13, 14; design partners onboarded |
| M3 — Beta | S18 | 15, 16, 17, 18, 19, 20; weekly client work end to end |
| M4 — Commercial GA | S24 | 21, 22, 23, 25 (hardening), 26, 28 |
| Post-GA | — | 27 and every `[post-GA]` item above |

## 31. Quality bars

- **Clips.** Acceptance ≥ 70% on fresh sources with minor or no boundary change; every surfaced range grounded and playable; the verifier from a different model family; sensor-clean files; cost per source-hour within target.
- **Transcripts.** Word timings that hold the sentence grid byte-stable across the two implementations; diarization treated as load-bearing.
- **Provenance.** Any asset, citation, chapter, or claim can be played back to the exact range that produced it, and the evidence report says so in writing.
- **Governance.** An approved asset cannot be published as anything other than its approved version; cross-tenant isolation is proven by automated probes on every PR.
- **Reliability.** Zero duplicate publishes; failed refreshes preserve the previous result; hard-killed workers are reaped, never left as ghosts.
- **Economics.** Every metered action is in the ledger the sprint it ships; a retry re-pays zero tokens; margin per client is visible in the product at GA.

## 32. Open questions

- Review-signal shape for pipeline runs (long-open workflow versus complete-at-ready plus a finalize workflow) — decided at the top of B1.
- Temporal hosting at cutover (self-host on the VPS versus Temporal Cloud).
- Design studio build-versus-buy after the Polotno spike (S12).
- Transcription ownership after the WhisperX A/B (C4).
- Notification infrastructure vendor (Knock versus Novu) at adoption time.
- Whether an agent-addressable API surface should arrive before GA given the market's direction.
