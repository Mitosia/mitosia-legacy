# Mitosia Sprint Plan

**Status:** Working plan — sequence is the commitment, calendar dates are not
**Inputs:** Feature specification, harness thesis, [tech-stack.md](tech-stack.md)
**Last updated:** 2026-09-02

> **2026-08-31 — pipeline rebuild:** harness work now builds on the Python/Temporal pipeline chassis; sequencing is governed by [pipeline-implementation-plan.md](pipeline-implementation-plan.md) (design: [pipeline-architecture.md](pipeline-architecture.md)). The sprint sequence below remains the record for the TS app and for deferred product work (S16 intake/connectors, S18 delivery, billing), which resumes after the harness roster completes.

> **2026-09-02 — competitive additions (Riverside audit):** thirteen roadmap items were added after auditing riverside.com/ai and its independent reviews against this plan. Each is marked *Competitive addition 2026-09-02* where it lives, and none changes the 2026-08-31 priority (harness roster first). Product-side, in the TS app and deferred with the rest of the app work unless it is itself a review surface for a lane: multi-track source groups (S10), non-contiguous assembled clips (S8), NLE handoff (S9), episode package (S11), audiograms and cross-source intelligence v1 (S12, the latter pulled forward from post-GA), batch intake with per-client queues (S16), the consent surface for word-level voice fixes (S21). Harness-side, on the Python chassis: steerable discovery (S7 entry, ships with the Phase B lanes), tangent/ramble trims and deterministic smooth cuts (R1, so C1), audio enhancement (new R8), caption translation pulled into C3 (R4), multicam driven by source groups (R2, so C6), and voice fixes as C3's last stage. Three explicit non-goals are recorded in §"Deliberately not building". The finished-product feature inventory these feed is [prd.md](prd.md).

## How to read this plan

- **Sprints are two weeks** and numbered S0–S24. Each has a goal, the build list, and an exit test (what must be demonstrable, on staging, with a real source file).
- **Sequence over dates.** The plan is sized for two to three full-time product engineers plus a founder doing product and design, working AI-assisted. A smaller team keeps the same sequence and stretches the calendar; nothing below assumes a specific launch date.
- **Milestones are gates, not ceremonies.** Each milestone has entry criteria; if a gate fails, the next phase does not start.
- **The spec is the target state, not the v1 scope.** This plan builds the smallest path through the spec that proves the core promise — one source becomes an approved, published, multi-format campaign — then widens.

## Cross-cutting rules (apply to every sprint)

1. Anything metered writes to the usage ledger from the sprint it ships in — cost visibility is never retrofitted.
2. Every new AI capability ships with Langfuse tracing and a small golden eval set in the same sprint; prompts change only through the registry.
3. Every new table carries organization scoping and RLS from the first migration; the cross-tenant isolation test suite grows with the schema.
4. Every sprint ends with a recorded demo run against a real long-form source, not a toy fixture.
5. From M2 onward, Mitosia's own marketing content is produced inside Mitosia (dogfooding is the first design partner).

## Milestones

| Gate | After | Proves |
|---|---|---|
| M0 — Walking skeleton | S3 | A real two-hour recording goes from upload to playable proxy and accurate, speaker-labeled transcript on production infrastructure |
| M1 — Magic moment | S6 | The system finds genuinely good moments: ranked, playable, explainable candidates a strategist agrees with |
| M2 — Private alpha | S11 | One source becomes a curated multi-format draft campaign (clips + written) with humans in the loop; 3–5 design partner agencies onboarded |
| M3 — Beta | S18 | Design partners run real weekly client work end to end: intake → production → client approval → verified publication |
| M4 — Commercial GA | S24 | Self-serve signup, billing, entitlements, onboarding, hardening, and reporting are live; unit economics are visible per client |

---

## Phase A — Foundation (S0–S3)

### S0 — Platform bootstrap
**Goal:** Deploy-on-merge to a real environment before any product code.
- Hostinger VPS provisioned; Dokploy installed; Cloudflare in front (DNS, CDN, WAF)
- Protected validation pipeline → Dokploy staging/production deployment
- Neon Postgres + Drizzle baseline; Better Auth skeleton; monorepo layout per tech-stack §15
- App shell: navigation frame, design tokens, dark mode, empty states
- Langfuse and Infisical containers running on Dokploy

**Exit:** A commit merged to main is live on production within minutes; sign-in works; a seeded health dashboard shows all services green.

### S1 — Tenancy and hierarchy
**Goal:** The canonical object model exists and is isolated.
- Organizations, members, invitations; roles v1 (owner, admin, member; contractor stub)
- Clients → brands → campaigns → projects CRUD with the context switcher
- RLS policies on every table; first automated cross-tenant isolation tests in the required PR gate
- Audit log table and event writer for sensitive actions

**Exit:** Two seeded organizations demonstrably cannot see each other's data through any UI or query path.

### S2 — Source ingest and media pipeline
**Goal:** Large real-world media flows in reliably.
- Uppy resumable multipart uploads direct to R2; source records, metadata, lifecycle states
- Trigger.dev ingest workflow: probe/validate → HLS proxy ladder → thumbnails → waveform peaks → audio extract
- Media player (media-chrome + hls.js) with waveform scrubbing
- Ledger entries for storage and processing minutes

**Exit:** A 2 GB, two-hour recording uploads with pause/resume and is playable as proxy shortly after; failures surface with retry.

### S3 — Transcription (Gate M0)
**Goal:** Trustworthy, editable transcript as the substrate for everything downstream.
- Deepgram adapter behind a provider interface; word timestamps, diarization, confidence
- Transcript viewer: click-to-seek, search, speaker naming, low-confidence highlighting
- Transcript corrections with versions; SRT/VTT export
- First provider-fallback test (AssemblyAI or WhisperX behind the same interface)

**Exit:** M0 demo — upload to accurate labeled transcript, end to end, on production infra.

---

## Phase B — Understanding and curation (S4–S7)

### S4 — Harness v1 and source analysis
**Goal:** The Mastra-based capability layer exists with observability from day one.
- Mastra wired with gateway routing and model tiering per tech-stack §7
- Context assembly v1: organization, brand, and source packs with versioned snapshots
- Source analysis capability: executive summary, chapters, topics, entities
- Source map UI v1; first golden eval set (chapter and summary quality on five reference sources)

**Exit:** Analysis runs are fully traced in Langfuse with cost per source-hour visible in the ledger.

### S5 — Deep source intelligence
**Goal:** Claims, quotes, and stories with exact provenance.
- Extraction capabilities: claims, quotes, stories, Q&A, CTAs — each linked to transcript ranges and timestamps
- Claim classification (direct quote, paraphrase, inference, unsupported) per thesis §16
- pgvector embeddings; semantic search within a source; source Q&A with cited timestamps

**Exit:** Ask a question of a source and get an answer with playable timestamped evidence; every extracted claim traces to its range.

### S6 — Moment discovery (Gate M1)
**Goal:** The product's first "wow": ranked, explainable, adjustable moments.
- Candidate generation with scoring dimensions (comprehensibility, hook, insight density, relevance, risk) and dedupe
- Candidate review UI: card gallery + transcript + instant playback with surrounding context
- Boundary adjustment with snap-to-sentence/pause; select, shortlist, reject with reasons
- Acceptance-rate and boundary-adjustment instrumentation (the north-star quality metrics)

**Exit:** M1 demo — a strategist reviews the top ten candidates from a fresh podcast and accepts most with minor or no boundary changes.

### S7 — Brand intelligence
**Goal:** Brand context governs generation before generation scales.
- Brand profile: visual kit (logos, colors, fonts), voice and tone, vocabulary, approved and prohibited claims, examples
- Brand profile versioning and approval states
- Brand packs flow into context assembly; brand-check evaluator v1 (terminology, prohibited phrases, claim status)
- Steerable discovery: a per-run strategist brief ("pricing objections for LinkedIn, CFO audience") composed into the Director pass of both clip lanes, stored on the run (`runs.params`) and in the audit log so every selection is explainable against what was asked. The brief steers *selection* only — grounding, the gauntlet, and the verifier are unchanged — and a brief-adherence score in the evaluator surfaces as a flag, never a gate. *Competitive addition 2026-09-02 (Riverside's chat editing, Opus ClipAnything); build home: the Phase B lanes and their review panels, since the brief input is a review surface.*

**Exit:** The same generation request produces visibly different, rule-respecting output for two different seeded brands, and the same source yields a visibly different keep set for two different strategist briefs.

---

## Phase C — Production studios (S8–S12)

### S8 — Edit spec and transcript-based video editing
**Goal:** Non-destructive editing model established before any rendering polish.
- Versioned edit-spec model (in/out ranges, layers, caption track, template reference) per thesis §19
- Transcript-based cutting: remove ranges, filler words, false starts; restore
- Timeline view v1 with frame-accurate trim; caption track generation with style presets
- Browser preview via Remotion Player driven by the same spec
- Non-contiguous assembled clips: an edit spec may hold an ordered set of grounded spans — a question at 04:10 joined to its answer at 40:05, a "three takes on X" montage — and the word-index EDL both lanes emit is multi-span by construction. Timeline and transcript views render the joins; the file sensors check onset clearance and loudness continuity at every join. *Competitive addition 2026-09-02 — Descript's clip finder and Riverside can only cut contiguous blocks.*
- Tangent, ramble, and false-start proposals inside kept material arrive from the tighten harness (R1/C1) as restorable edit-spec suggestions with a reason, never auto-applied

**Exit:** Cut a clip entirely from the transcript and preview it with captions without any server render; an assembled two-span clip previews with no audible seam.

### S9 — Rendering pipeline
**Goal:** Reproducible branded renders with tiering and caching.
- Remotion brand templates: captions, titles, logo, progress bar, lower thirds
- FFmpeg cut and loudness normalization; render tiers (instant preview, watermarked review, platform final)
- Render queue UI with status, retry, cost; render cache keyed by spec hash
- Golden-fixture render determinism tests
- Audio enhancement as a metered render layer: noise and reverb cleanup behind a provider seam (Dolby.io, Auphonic, or self-hosted DeepFilterNet on Modal), per track once source groups exist (S10), with a before/after preview and one ledger entry per render. The sensor contract is R8. *Competitive addition 2026-09-02 (Riverside Magic Audio, its most-praised feature; Mitosia had only loudness normalization).*
- Deterministic smooth cuts: alternating punch-in on transcript cuts, never across a shot boundary (the ingest `shots` artifact), as template behaviour gated by R1's jump-cut sensor. *Competitive addition 2026-09-02 (Riverside lists "Smooth Cuts" as coming soon).*
- NLE handoff: FCPXML, EDL, and Premiere XML export of an approved edit spec, multi-span aware, carrying the evidence manifest, so an agency's editor can finish in their own tool. *Competitive addition 2026-09-02 (Opus and Eddie have it; Riverside does not).*
- Multilingual caption tracks render through the same templates once C3's translation stage lands (brand glossary, back-translation judge)

**Exit:** A selected moment becomes a 9:16 captioned, branded MP4; re-rendering an unchanged spec hits the cache; the same spec exports as FCPXML that opens in Final Cut with the cuts intact.

### S10 — Reframing, multi-track layouts, and aspect variants
**Goal:** One edit, every aspect ratio — and every camera.
- Multi-track source groups: a Riverside, Zoom, Squadcast, or Descript export ingests as one source holding per-speaker audio/video tracks plus the mix; tracks are aligned to the mix at ingest and diarization binds to track identity. This is the multi-file session modeling that C6 (multicam) needs — the one place Phase C touches the TS app beyond review surfaces — and it unlocks per-speaker mute, per-track audio cleanup (S9), and speaker-switching layouts driven by track activity rather than face tracking, which is cheaper and more accurate for interview content. Lands before the face-tracking work below. *Competitive addition 2026-09-02 (Riverside Smart Layouts and Smart Mute, which work only on Riverside's own recordings).*
- Active-speaker and face detection on Modal; auto crop keyframes (the C5 smart-reframe harness owns the crop keyframe path and its sensors; this sprint supplies the perception layer and the UI)
- Manual crop override editor; platform safe-zone overlays
- Aspect variants (9:16, 1:1, 16:9) inheriting from a base edit

**Exit:** A two-speaker landscape recording auto-reframes to a watchable vertical clip; a human can correct any shot in seconds; a four-track interview export switches layouts from track activity with no computer vision in the loop.

### S11 — Written content studio (Gate M2)
**Goal:** Source-grounded writing closes the multi-format loop.
- Tiptap editor with grounded generation: LinkedIn posts, X threads, newsletter section
- Sentence-level evidence links to transcript ranges; unsupported-claim flags
- Hook variants, platform length rules, realistic platform previews
- Brand voice checks wired to the S7 evaluator
- Episode package: show notes, YouTube chapters with timestamps, title and description variants, keywords, pull quotes, and guest bios — every sentence grounded to a transcript range, built from the S4/S5 analysis and extraction data plus the pipeline's `chapters.json` and description artifacts, checked by the brand evaluator. One deliverable every podcast client asks for on day one. *Competitive addition 2026-09-02 (Riverside AI show notes; Mitosia's version is grounded and per-brand).*

**Exit:** M2 demo — one source becomes six clips plus four written assets, curated by a human, inside one project. **Alpha begins:** onboard 3–5 design partner agencies. **Start now, long lead time:** platform API applications and app reviews (LinkedIn, Meta/Instagram, YouTube, TikTok).

### S12 — Asset families, library, and static visuals v1
**Goal:** Everything produced is organized, versioned, and reusable.
- Variant and asset-family model with lineage panel
- Asset library: filters, search, statuses, versions
- Quote cards via Satori templates; carousel copy output
- Polotno SDK spike concluded → build-vs-buy decision recorded for the design studio
- Audiograms: waveform-plus-caption video for audio-only sources through the Remotion/Satori template path, in every aspect variant — a large share of podcast clients have no video. *Competitive addition 2026-09-02.*
- Cross-source intelligence v1, pulled forward from post-GA: client-wide semantic search over the existing `transcript_chunk` vectors, "this guest said the same thing in episode 12" twin detection across sources via the chunk-vector cosine, and cross-episode guest profiles. Cheap because pgvector and the index lifecycle already exist. *Competitive addition 2026-09-02 — Riverside is one recording at a time.*

**Exit:** Every alpha-produced asset is findable, versioned, and traceable back to its source moment; a search across a client's library returns playable ranges from more than one source.

---

## Phase D — Collaboration and governance (S13–S16)

### S13 — Canvas studio
**Goal:** The visual campaign graph over data that already exists.
- React Flow canvas auto-generated from the project: sources → moments → assets → reviews
- Typed nodes with status, thumbnails, counters; typed edges; inspector panel
- Lane auto-layout (elkjs); synchronized table and board views of the same graph

**Exit:** A design partner navigates a real campaign entirely from the canvas and drills into any editor from a node.

### S14 — Collaboration layer
**Goal:** Multiple people work in the same project without collisions.
- Comments on assets, transcript ranges, and video frames; mentions; threads
- Tasks with assignment, status, and due dates; project activity feed
- Presence and live cursors (Liveblocks) on canvas and documents
- Unified notification inbox v1 and email digests via Resend

**Exit:** Two users edit and discuss the same project concurrently; the third catches up from inbox and activity feed alone.

### S15 — Review and approval engine
**Goal:** The governance invariants the whole product hangs on.
- Review requests with stages (internal → client), sequential or parallel, required approvers
- Version-pinned approvals; material edits invalidate per policy; immutable approval audit trail
- Proofing surfaces: frame- and range-accurate video comments, text selections, image regions
- Revision rounds with counters against the entitlement model (stubbed limits)

**Exit:** An approved asset cannot be edited or published as anything other than its approved version — demonstrated, not asserted.

### S16 — Client portal v1
**Goal:** Clients participate without seeing agency internals.
- White-label portal: logo, colors, custom domain (Cloudflare for SaaS)
- Client roles; simplified review with approve / request changes; source-evidence view
- Approved-asset library and delivery downloads; intake/request form v1
- Source-import connectors behind one interface: direct file URL + Google Drive / Dropbox / Zoom cloud recordings, and Vimeo via its owner-authenticated download API — fetched into R2 under the org prefix, through the same ClamAV scan and ingest pipeline as uploads. **No YouTube extraction** (no official download API; yt-dlp violates ToS and datacenter IPs get bot-blocked — decision 2026-08-24, AGENTS.md); the support answer is "download from YouTube Studio and upload". Recording-studio exports (Riverside, Descript, Squadcast) join the same interface through whatever owner-authenticated download path each offers; where a studio has none, the multi-file upload path (source groups, S10) is the connector
- Batch intake with per-client queues: bulk upload and bulk connector import, per-client concurrency keys on the durable runtime, a queue view showing position and truthful progress (no invented ETAs), and recipe defaults applied on arrival once S21 wires the recipe. *Competitive addition 2026-09-02 — Riverside reviewers: "each recording must be handled individually".*
- Internal-only versus client-visible comment scoping enforced

**Exit:** A real client contact reviews and approves a batch on their phone under the agency's domain, never seeing internal data.

---

## Phase E — Distribution (S17–S18)

### S17 — Publishing wave 1
**Goal:** Approved variants reach platforms reliably.
- Nango-managed connections for LinkedIn, X, YouTube; account health and reauthorization
- Destination-specific composer (copy, media, thumbnail, first comment, links)
- Preflight checks (approval state, format, rights, schedule conflicts)
- Durable idempotent publish jobs with receipts, remote IDs, and post-publish verification

**Exit:** Ten consecutive scheduled publishes across three platforms with zero duplicates and actionable failure states for forced errors.

### S18 — Scheduling, calendar, and delivery (Gate M3)
**Goal:** The full agency loop closes.
- Content calendar: production, approval, and publication events; drag to reschedule; timezone-aware
- Approval-gated scheduling and queues; export packages (ZIP, manifest, evidence report) and storage delivery
- Failure dashboards for publishing operations

**Exit:** M3 — at least two design partners run a full weekly client workload (intake → publish) in-platform; publishing success rate holds at target for two consecutive weeks.

---

## Phase F — Commercial and intelligence (S19–S21)

### S19 — Billing and entitlements
**Goal:** Revenue infrastructure on the MoR rail.
- Dodo Payments integration: plans, subscription lifecycle, webhooks, customer portal
- Entitlement engine enforcement: seats, clients, source hours, render minutes — with explain-why-blocked UX
- Pre-action estimates and overage prompts; usage dashboard per organization and client

**Exit:** A design partner converts to a paid plan; hitting a limit produces a clear, resolvable prompt, not a dead end.

### S20 — Analytics and reporting v1
**Goal:** Close the loop from publication back to source.
- Metrics collection through platform adapters into the normalized analytics layer
- Lineage dashboards: publication → asset → moment → source; campaign and client views
- Branded scheduled client report v1 delivered to the portal

**Exit:** A client report shows which source moments produced the best-performing posts, with numbers pulled automatically.

### S21 — Recipes and learning loop v1
**Goal:** Repeatability — the agency's process becomes product.
- Recipes v1: deliverable set, defaults, owners, approval chain; one-click project generation from a recipe
- Moment-ranking calibration from acceptance and performance data
- Brand memory suggestions (from reviewer feedback classification) with approve/reject/expire UX
- Publishing wave 2 as platform app approvals land (Instagram/Meta, TikTok)
- Consent-gated word-level voice fixes, the product surface: per-speaker consent records in the rights/consent tables, a fix-this-word action in the transcript editor for a misspoken name or number, synthetic ranges marked in the edit spec and the evidence report, and a refusal path when no consent row exists. The synthesis itself is the last stage of the C3 harness (TTS seam, duration-fit sensors). Scoped to fixes, never rewrites. *Competitive addition 2026-09-02 (Riverside VideoDub).*

**Exit:** A returning weekly podcast client is set up once as a recipe and every new episode spawns a correctly structured project; a consented speaker's misspoken number is fixed in place and the evidence report shows the synthetic range.

---

## Phase G — Hardening and launch (S22–S24)

### S22 — Hardening
**Goal:** Boring under stress.
- Security pass: isolation suite green in the required PR gate, audit coverage review, signed-URL and rights-blocking audit, rate limits
- Load tests on ingest, render, and publish paths; cost-per-source-hour review against targets
- Incident runbooks, status page, alerting SLOs; backup restore drill

**Exit:** A simulated bad week (provider outage, render backlog, failed publishes, expired tokens) is handled with tools, not heroics.

### S23 — Onboarding and polish
**Goal:** Strangers succeed without hand-holding.
- Organization onboarding wizard: first client, brand intake, first recipe, sample project experience
- Empty states, guided tours, help docs; brand-kit and asset import basics
- Accessibility pass on core flows; i18n/RTL verification; billing and legal surfaces finalized

**Exit:** A cold-start agency reaches its first curated moment portfolio without support contact — tested with a fresh recruit.

### S24 — GA launch (Gate M4)
**Goal:** Open the doors.
- Pricing and packaging live; trial flow; marketing site aligned to positioning
- Final eval regression and prompt freeze; observability dashboards and paging rotations confirmed
- Support workflows and feedback capture in place; launch

**Exit:** M4 — self-serve signups convert to active production without founder intervention; margin per client is visible in-product.

---

## Post-GA roadmap (sequenced later, deliberately out of v1)

Automation builder (triggers/conditions/actions), audio and podcast studio depth, voice dubbing studio (caption translation moved into C3 and word-level voice fixes into S21/C3 on 2026-09-02; full-episode dubbing in a cloned voice stays here), experiments framework, archive mining depth (cross-source search, twin detection, and guest profiles moved to S12 on 2026-09-02), grounded B-roll from the client's own asset library or licensed stock with rights tracking (the version of "AI B-roll" worth building — see §"Deliberately not building"), agency ops and profitability reporting depth, public API + webhooks + developer portal, enterprise pack (SSO/SCIM, residency, audit export, custom roles at scale), mobile companion app (Expo), template and recipe marketplace, additional publishing and intake connectors.

## Deliberately not building (decision 2026-09-02, Riverside audit)

- **Recording.** Riverside's studio is a different company. Mitosia starts after the master exists and takes it from wherever it was recorded: upload-first, connectors at S16, multi-track source groups at S10. Competing on capture would dilute the harness.
- **Eye-contact and gaze correction.** Creator polish with no agency pull; revisit only on design-partner demand, and then as a bought Modal model behind the render seam, never core work.
- **Generative B-roll.** Unlicensed synthetic footage under a client's brand is a rights liability and off-thesis (every asset must trace to the source). The version worth doing is grounded B-roll from the client's library or licensed stock, rights-tracked, recorded in the post-GA roadmap.
- Standing rejections that this audit re-confirmed: YouTube extraction (2026-08-24), virality scores without behavioral ground truth ([clipping-landscape.md](clipping-landscape.md) §3), and aggregator publishing ([tech-stack.md](tech-stack.md) §12).

## Harness workflow roadmap (recorded 2026-08-31 — high level; extend per workflow when it is scheduled)

> **Build home update (2026-08-31, later the same day):** these workflows ship as Phase C lanes on the Python pipeline chassis — order and phase gates in [pipeline-implementation-plan.md](pipeline-implementation-plan.md) §Phase C. The per-sprint "home" notes below predate the rebuild decision and are superseded by that plan; the spec/sensor detail in the entries stays authoritative.

The clip lanes proved a five-layer recipe that generalizes across editing workflows: **structured perception → declarative spec (the model addresses indices, never pixels or raw timestamps) → deterministic execution → computable sensors → separate evaluator → fixture flywheel.** Per workflow, only two things change: what the spec is and what the sensors check. Build order ranks by the **fraction of quality that is deterministically checkable** — high-computable workflows (filler removal, captions ≈ 90%) reach reliable automation fast and cheap; low-computable ones (trailers ≈ 30%) burn evaluator tokens and keep human review queues longer. For Mitosia the adjacency order is **5 → 3 → 2 (mid-roll insertion → smart reframe → multicam)**: each reuses the existing perception layer and boundary machinery, so the marginal harness is mostly new sensors, not new architecture. Entries below are deliberately high level; the per-workflow spec and sensor detail get designed into the plan when each is actually scheduled.

1. **Silence & filler removal (rough-cut editing)** — home: extends S8 transcript-based cutting. Spec: a list of word/gap indices to delete. Mostly deterministic (pause map + filler lexicon from the transcript); the LLM judges only ambiguous cases ("you know" as filler vs. meaningful). Sensors: no clipped word onsets (cut points checked against word timestamps), resulting pace within a WPM band, max consecutive jump-cuts. Easiest harness of the lot — nearly all feedback is computable. **Extended 2026-09-02 (Riverside audit):** the same EDL carries (a) **tangent/ramble trims inside kept material** — sentence-ID ranges with a reason taxonomy (`tangent`/`ramble`/`false_start`/`told_twice`) proposed by the model, restorable, never auto-applied; sensors: the payoff sentence survives, the remaining text is sentence-complete, `told_twice` is confirmed by the chunk-vector cosine — and (b) **deterministic smooth cuts** — alternating punch-in on cuts, never across a shot boundary, with the jump-cut sensor as the gate. Both are C1 scope.
2. **Multicam auto-switching (podcast/interview)** — unscheduled. Perception: diarization + per-camera face presence. Spec: a camera cut list `{time, cam_id}` keyed to word indices. Sensors: min shot length ~2s, no cut mid-word, active speaker on-camera ≥90% of their talk time, max time-on-one-camera. Evaluator samples segments for "does the cut rhythm feel motivated." Descript/Riverside ship versions of this; the harness gap — and the edge — is the verification layer. **Perception update 2026-09-02:** when a multi-track source group (S10) exists, per-track activity is the primary speaker signal and face presence is the fallback; per-speaker mute and per-track cleanup ride the same group.
3. **Smart reframe (16:9 → 9:16 subject tracking)** — home: S10, upgrading its default from center-crop. Perception: face/saliency track per frame. Spec: a crop **keyframe path**, never per-frame crops. The sensors are the whole product here: subject-in-frame ratio, crop velocity/acceleration caps (jitter kills quality), no crop pans across a shot boundary (the ingest `shots` artifact already provides the boundaries).
4. **Captions, translation, dubbing** — home: captions land with S8/S9; **caption translation lands with C3** (pulled forward from post-GA 2026-09-02: brand glossary + translation memory, back-translation-consistency judge); full-episode voice dubbing stays post-GA. Spec: subtitle segments with line breaks. The deterministic sensor layer comes free from mature broadcast standards — chars/sec ≤ 17, line length ≤ 42, sync drift, shot-change crossing rules — an unusually strong sensor layer for the cost. Translation adds an LLM judge (back-translation consistency); dubbing adds duration-fit sensors (translated audio fits the source segment ±10%). **C3's last stage is consent-gated word-level voice fixes** (2026-09-02): the TTS/voice seam at word granularity for a misspoken name or number; sensors: duration fit ±10%, a consent row for the speaker or the activity refuses, the synthetic range flagged in the spec and the evidence report. Product surface in S21.
5. **Mid-roll ad insertion** — unscheduled; cheapest adjacency, first in line. This is the segment-lane boundary detector with a different objective: boundaries ranked by topic-completion strength and distance from narrative peaks. Spec: ranked insertion points. The sensors (snap to pause, min spacing) already exist in `lib/intelligence`.
6. **Trailer/teaser generation** — unscheduled; hardest to sense deterministically, build last. Spec: ordered sparse segments with role labels (hook/tension/reveal-withheld). Quality is narrative arc, so the evaluator carries most weight (gates: no spoiler segment included, hook within the first 3s, each segment comprehensible standalone). Reliability flag: this is the workflow where LLM-judge scores correlate worst with human preference — expect the widest gap between eval pass and human judgment, and budget the deepest fixture set and the longest human-in-loop period. Assembled clips (S8) share this sparse-segment EDL shape, which is why they are an edit-spec feature rather than a harness of their own.
7. **Best-take assembly (scripted content)** — unscheduled. Perception: align each take's transcript to the script (edit distance per line). Spec: `{script_line → take_id, word_range}`. Sensors: full script coverage, per-line WER threshold, audio-level continuity across take joins (RMS delta cap), no visual jump at joins unless separated by a cutaway. Very harness-friendly — the script is ground truth, which most video workflows lack.
8. **Audio enhancement (noise, reverb, loudness)** — added 2026-09-02 (Riverside audit); unscheduled, slots with C1's file-level sensor battery because it is the first enhancement chain that battery has to certify. Perception: per-track noise floor, reverb estimate, speech-band energy. Spec: a declarative enhancement chain per track (denoise strength, dereverb, EQ preset, target LUFS) — never raw filter strings outside `render/`. Sensors: two-pass −14 LUFS ±1.5, no clipped onsets, speech-band energy preserved within a band (an enhancer that eats consonants fails), noise-floor drop at or above target, before/after evidence rendered for review. Provider seam (Dolby.io / Auphonic / DeepFilterNet on Modal) behind the activity; the evaluator only samples for artifacts. Metered per render (S9).

## Top risks and standing mitigations

| Risk | Mitigation |
|---|---|
| Social platform app reviews take weeks–months (Meta, TikTok, LinkedIn, YouTube quotas) | Applications filed at S11 (M2), not when publishing ships at S17; wave 2 platforms land as approvals arrive |
| Media pipeline complexity underestimated (VFR sources, long files, render costs) | Pipeline is built in S2 and exercised by every sprint demo thereafter; golden fixtures catch regressions; proxy-first keeps iteration cheap |
| Canvas scope creep (building Figma instead of Mitosia) | Canvas deliberately lands S13, after the production loop already works via plain views; canvas renders existing truth, it never owns it |
| AI cost per source-hour erodes margin | Ledger from S1, model tiering + prompt caching + Batch API from S4, per-sprint cost review against targets |
| Moment quality disappoints (the product's core bet) | M1 is an explicit quality gate with acceptance-rate instrumentation; failing it pauses downstream phases in favor of curation quality |
| Design partner availability and feedback latency | Recruitment starts at M1, onboarding at M2; dogfooding on Mitosia's own content is the always-available fallback partner |
| Approval/version integrity bugs destroy client trust | S15 invariants get dedicated adversarial tests; publishing preflight re-verifies approval state independently |
| Small-team bandwidth | Sequence is fixed, calendar flexes; each sprint's exit test defines "done" so scope cuts happen inside sprints, not across the sequence |
