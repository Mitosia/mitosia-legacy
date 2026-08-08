# Mitosia Sprint Plan

**Status:** Working plan — sequence is the commitment, calendar dates are not
**Inputs:** Feature specification, harness thesis, [tech-stack.md](tech-stack.md)
**Last updated:** 2026-08-08

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
- GitHub Actions pipeline: checks → Docker image → GHCR → Dokploy staging/production
- Neon Postgres + Drizzle baseline; Better Auth skeleton; monorepo layout per tech-stack §15
- App shell: navigation frame, design tokens, dark mode, empty states
- Langfuse and Infisical containers running on Dokploy

**Exit:** A commit merged to main is live on production within minutes; sign-in works; a seeded health dashboard shows all services green.

### S1 — Tenancy and hierarchy
**Goal:** The canonical object model exists and is isolated.
- Organizations, members, invitations; roles v1 (owner, admin, member; contractor stub)
- Clients → brands → campaigns → projects CRUD with the context switcher
- RLS policies on every table; first automated cross-tenant isolation tests in CI
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

**Exit:** The same generation request produces visibly different, rule-respecting output for two different seeded brands.

---

## Phase C — Production studios (S8–S12)

### S8 — Edit spec and transcript-based video editing
**Goal:** Non-destructive editing model established before any rendering polish.
- Versioned edit-spec model (in/out ranges, layers, caption track, template reference) per thesis §19
- Transcript-based cutting: remove ranges, filler words, false starts; restore
- Timeline view v1 with frame-accurate trim; caption track generation with style presets
- Browser preview via Remotion Player driven by the same spec

**Exit:** Cut a clip entirely from the transcript and preview it with captions without any server render.

### S9 — Rendering pipeline
**Goal:** Reproducible branded renders with tiering and caching.
- Remotion brand templates: captions, titles, logo, progress bar, lower thirds
- FFmpeg cut and loudness normalization; render tiers (instant preview, watermarked review, platform final)
- Render queue UI with status, retry, cost; render cache keyed by spec hash
- Golden-fixture render determinism tests

**Exit:** A selected moment becomes a 9:16 captioned, branded MP4; re-rendering an unchanged spec hits the cache.

### S10 — Reframing and aspect variants
**Goal:** One edit, every aspect ratio.
- Active-speaker and face detection on Modal; auto crop keyframes
- Manual crop override editor; platform safe-zone overlays
- Aspect variants (9:16, 1:1, 16:9) inheriting from a base edit

**Exit:** A two-speaker landscape recording auto-reframes to a watchable vertical clip; a human can correct any shot in seconds.

### S11 — Written content studio (Gate M2)
**Goal:** Source-grounded writing closes the multi-format loop.
- Tiptap editor with grounded generation: LinkedIn posts, X threads, newsletter section
- Sentence-level evidence links to transcript ranges; unsupported-claim flags
- Hook variants, platform length rules, realistic platform previews
- Brand voice checks wired to the S7 evaluator

**Exit:** M2 demo — one source becomes six clips plus four written assets, curated by a human, inside one project. **Alpha begins:** onboard 3–5 design partner agencies. **Start now, long lead time:** platform API applications and app reviews (LinkedIn, Meta/Instagram, YouTube, TikTok).

### S12 — Asset families, library, and static visuals v1
**Goal:** Everything produced is organized, versioned, and reusable.
- Variant and asset-family model with lineage panel
- Asset library: filters, search, statuses, versions
- Quote cards via Satori templates; carousel copy output
- Polotno SDK spike concluded → build-vs-buy decision recorded for the design studio

**Exit:** Every alpha-produced asset is findable, versioned, and traceable back to its source moment.

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

**Exit:** A returning weekly podcast client is set up once as a recipe and every new episode spawns a correctly structured project.

---

## Phase G — Hardening and launch (S22–S24)

### S22 — Hardening
**Goal:** Boring under stress.
- Security pass: isolation suite green in CI, audit coverage review, signed-URL and rights-blocking audit, rate limits
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

Automation builder (triggers/conditions/actions), audio and podcast studio depth, translation and dubbing studio, experiments framework, archive mining and cross-source intelligence, agency ops and profitability reporting depth, public API + webhooks + developer portal, enterprise pack (SSO/SCIM, residency, audit export, custom roles at scale), mobile companion app (Expo), template and recipe marketplace, additional publishing and intake connectors.

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
