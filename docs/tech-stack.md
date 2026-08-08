# Mitosia Tech Stack

**Status:** Proposed baseline — decisions here are defaults, revisit only with a reason
**Inputs:** `final-agency-content-operations-platform-feature-specification.md`, `superior-ai-content-workflow-harness-thesis.md`, AceBuilder stack blueprint
**Last updated:** 2026-08-08

Mitosia is an agency-grade AI content operations platform: long-form sources in → understood, curated, produced, reviewed, approved, published, measured — inside one governed visual workspace. The durable product is the **harness** (content graph + durable workflow runtime + context assembly + evaluation + memory), not any single model or renderer.

This document maps every product layer to a concrete technology choice. Format per slot: **Pick** → why → alternative (only where a credible second option exists).

---

## 1. Guiding principles

1. **Build the harness, buy the plumbing.** Same principle AceBuilder validated: a small team's time goes into the content graph, workflow runtime, editorial intelligence, and brand memory — not into running databases, auth, email, or webhook delivery.
2. **AI for judgment, deterministic software for precision.** Models plan, curate, write, and evaluate. Software validates, trims, renders, stores, authorizes, schedules, meters, and publishes.
3. **Every provider is replaceable.** Transcription, LLMs, renderers, and social APIs sit behind adapters in dedicated packages. The domain layer never imports a provider SDK directly.
4. **Non-destructive by design.** Edits are versioned JSON specifications; renders are reproducible functions of (source, spec, template version).
5. **Tenant isolation is structural, not conventional.** `organization_id` (and `client_id` where applicable) on every row, storage prefix, queue payload, vector namespace, and cache key — enforced with Postgres RLS, not code review.
6. **Unit economics are a feature.** Usage ledger, budgets, model tiering, prompt caching, and proxy-first rendering exist from day one, because source-hours of media and frontier-model calls will dominate COGS.

---

## 2. Already in place (keep all of it)

| In repo today | Role | Verdict |
|---|---|---|
| Next.js 16.3 (App Router) | Full-stack application framework | Keep — matches AceBuilder's #1 pick. Note: this Next version has breaking changes; consult `node_modules/next/dist/docs/` before coding |
| React 19.2 | UI runtime | Keep |
| Tailwind CSS v4 | Styling | Keep |
| shadcn/ui + `@base-ui/react` | UI primitives | Keep — Base UI variant is fine; be consistent, don't mix Radix |
| Hugeicons | Icon system | Keep |
| Ultracite (Biome) | Lint/format | Keep — fast, zero-config; replaces ESLint+Prettier |
| Google Sans + RTL setup | Typography, i18n groundwork | Keep — RTL aligns with the localization requirements (§37.6) |
| pnpm | Package manager | Keep — becomes workspace root when the monorepo lands |
| TypeScript 5 (strict) | Language | Keep — one language across app, workers, and workflow code |

---

## 3. Frontend application layer

| Slot | Pick | Why |
|---|---|---|
| Framework | **Next.js 16 (App Router, RSC)** | Team velocity, streaming, server actions for internal mutations; inherited from AceBuilder |
| Server state | **TanStack Query** | Cache/invalidations for the many list+detail surfaces; pairs with streaming job status |
| Client state | **Zustand** | Editor/canvas/panel UI state; small, unopinionated (AceBuilder-proven) |
| URL state | **nuqs** | Type-safe filters/views — spec demands shareable saved views everywhere |
| Forms + validation | **react-hook-form + Zod 4** | Briefs, intake forms, recipe builders are form-heavy; Zod schemas shared client/server/API |
| Tables | **TanStack Table + TanStack Virtual** | Production tables, ledgers, libraries at 10k+ rows |
| Drag & drop | **dnd-kit** | Kanban, calendar scheduling, carousel page reorder, matrix drag |
| Command palette | **cmdk** | Universal command experience (§4.3) |
| Toasts/drawers | **Sonner + Vaul** | AceBuilder-proven; prefer contextual inline feedback where the action lives |
| Charts | **Recharts** (dashboards) → **ECharts** for heavy analytics (retention curves, large time series) | Recharts for speed now; ECharts when analytics surfaces mature |
| Media playback | **media-chrome + hls.js** | Custom-styled player over HLS proxies |
| Waveforms | **peaks.js** (precomputed peaks server-side) | Transcript/timeline editors need instant waveform paint on long sources |
| i18n | **next-intl** | Product localization + RTL already scaffolded |
| Dates/timezones | **date-fns + @internationalized/date** | Timezone-correct scheduling is a hard requirement (§26) |
| Animation | **Motion** | Canvas transitions, review UI polish |

**API surface strategy:** server actions + route handlers with Zod for the first-party app; a versioned public API comes later as **Hono + zod-openapi** route handlers in the same repo (spec §30.4 requires idempotency keys, scoped keys, pagination — design the internal service layer so handlers are thin). Don't build tRPC and a public API; one typed service layer, two thin transports.

---

## 4. Campaign canvas & real-time collaboration

The Figma-like studio is the control surface for the content graph (§14). It is a **node-graph editor**, not a freeform drawing tool — that changes the pick.

| Slot | Pick | Why |
|---|---|---|
| Canvas engine | **React Flow (@xyflow/react)** | Purpose-built for typed nodes/edges, custom node renderers, minimap, lasso, snapping; leaves rendering in React so node cards (thumbnails, status, counters) are ordinary components |
| Auto-layout | **elkjs** (layered) + custom lane constraints | Auto-generated graphs from briefs/recipes need deterministic swimlane layout (§14.6) |
| Collaboration data model | **Yjs (CRDT)** | Presence, live cursors, conflict-safe concurrent edits, offline tolerance — for canvas docs and rich-text docs alike |
| Collab backend | **Liveblocks** (managed Yjs + presence + comments primitives) to start; **Hocuspocus (self-hosted)** as the cost/control graduation | Buy during validation per principle 1; Liveblocks also accelerates pinned comments/threads (§14.13). The Yjs document format is identical either way — switching is a transport swap |
| Canvas persistence | Yjs snapshots + **canonical graph in Postgres** | The canvas is a *view* of the content graph. Nodes/edges/status live in Postgres as source of truth; Yjs carries positions, ephemeral presence, and in-progress edits. Never let the CRDT own approval or lineage state |

**Anti-choice:** tldraw / PixiJS custom renderer — right for infinite freeform drawing, wrong for a typed workflow graph; revisit only if node counts break React rendering (mitigate first with collapsed branches + virtualization, §14.14).

---

## 5. Content editors

| Studio | Pick | Why |
|---|---|---|
| Written content (§17) | **Tiptap (ProseMirror)** + Yjs collab | Best ecosystem for suggested edits, track changes, comments, mentions — all hard spec requirements. Lexical (AceBuilder's pick) is better for prompt inputs than for collaborative documents |
| Prompt/instruction inputs | **Tiptap mentions** (`@moment`, `@brandrule`, `@asset` structured references) | Same editor family everywhere; structured context injection like AceBuilder's Lexical `@` plugin |
| Transcript editor (§12.2) | Custom React on top of **word-timestamped transcript model** + peaks.js + virtualized rendering | This is core IP — word-level seek/edit/diarization correction; no off-the-shelf editor fits |
| Video edit spec | Custom **JSON edit-spec** (in/out ranges, crop keyframes, caption track ref, template version, layers, audio chain) exactly per thesis §19 | The canonical, versionable, renderable artifact. Timeline and transcript editors are two views over it |
| Video preview | **Remotion Player** for composition preview (captions, overlays, brand layers) over HLS proxy video | One React codebase defines both preview and final render — eliminates preview/render drift |
| Static & carousel studio (§18) | **Polotno SDK** (Konva-based, commercial) — evaluate first; fallback: build on **Konva** | A Canva-grade editor is months of work; Polotno is the single biggest buy-vs-build lever in the design studio. Templates export as JSON = versionable brand templates |
| Static template server render | **Satori** (simple text/quote cards) + **Playwright screenshot** (complex Polotno/HTML templates) | Deterministic, brand-token-driven |
| Code/expression editing (automations) | **CodeMirror 6** + **Shiki** for display | Monaco is overkill here; CodeMirror is lighter for expression fields |
| Long-doc rendering | **react-markdown + Shiki** | Plans, reports, AI output display |

---

## 6. Media pipeline (ingest → understand → render)

The heaviest divergence from AceBuilder — they run generated web apps; Mitosia processes hours of video. This is a first-class subsystem.

### 6.1 Ingest

| Slot | Pick | Why |
|---|---|---|
| Upload client | **Uppy** (AwsS3 multipart plugin) | Resumable multipart, pause/retry, folder upload, progress persistence (§11.2) |
| Upload target | **Cloudflare R2** presigned multipart, keys prefixed `org/{orgId}/client/{clientId}/...` | Zero egress fees — decisive for a media platform that renders, previews, and delivers constantly. AceBuilder-proven |
| Validation/probe | **ffprobe + MediaInfo** in ingest worker | Container/codec/VFR/loudness/corruption checks before production (§11.6) |
| Malware scan | **ClamAV** container in ingest path | Client-portal uploads are untrusted input |
| Proxies & delivery | **FFmpeg** → HLS ladder + audio extract + thumbnails/sprite sheets + `audiowaveform` peaks → R2 behind **Cloudflare CDN** | Proxy-first editing keeps every editor fast and every preview cheap |

### 6.2 Source intelligence

| Slot | Pick | Why |
|---|---|---|
| Transcription + diarization | **Deepgram** (primary), **AssemblyAI** (secondary), **WhisperX on Modal** (cost/self-host fallback) — behind one `TranscriptionProvider` adapter | Word timestamps + diarization + custom vocabulary; provider replaceability is a thesis requirement |
| Scene/shot detection | **PySceneDetect + FFmpeg** on workers | Deterministic, cheap |
| Face / active-speaker detection (reframing) | **Modal (serverless GPU)** running open ASD + face-tracking models (TalkNet/Light-ASD family + InsightFace); CPU fallback: MediaPipe center-weighted crop | The hardest CV problem in the product; per-second GPU billing, scales to zero |
| Audio intelligence | **FFmpeg (silencedetect, loudnorm/EBU R128) + librosa/pyloudnorm** on Python workers | Energy/pause/filler analysis feeding moment scoring |
| Semantic analysis (chapters, topics, claims, quotes, stories, moment candidates) | **Claude via the AI layer (§7)** over transcript + audio/visual signals, Batch API for full-source passes | This is editorial judgment — the model's job, orchestrated by the harness |

### 6.3 Rendering

| Slot | Pick | Why |
|---|---|---|
| Clip cutting/transcode | **FFmpeg** driven by the edit spec | Deterministic trims, aspect conversion, loudness, mezzanine |
| Branded composition (captions, overlays, lower thirds, progress bars, audiograms) | **Remotion** (server render on Trigger.dev machines or Remotion Lambda) | Brand templates as versioned React components = core IP, testable, deterministic; company license is cheap vs. building a compositor |
| Render tiers | Instant browser preview (Remotion Player) → watermarked review render (low bitrate) → platform-ready final → archive master | Direct implementation of thesis §19.2; render cache keyed by spec hash |
| Dubbing / TTS / voice (consented) | **ElevenLabs** | Dubbing API + voice cloning with documented consent (§19.4) |
| Translation | **Claude** with brand glossary + translation memory tables; **DeepL** as comparator | Glossary/tone control matters more than raw MT |
| Image generation / bg removal | Gateway-routed image models (Flux/Recraft/gpt-image) + **rembg/BiRefNet** on Modal | Behind the same provider-adapter discipline |

---

## 7. AI & agent harness

The harness is Mitosia's product. Specialists (Planner, Source Analyst, Moment Curator, Clip Director, Channel Adapter, Brand Guardian, Evaluators, Review Coordinator, Publishing Operator, Performance Analyst) are **bounded capabilities in a deterministic graph** — most are structured model calls with tools, not free-running agents.

| Slot | Pick | Why |
|---|---|---|
| Agent/capability framework | **Mastra 1.0** (agents, typed tools, workflows with suspend/resume, memory, RAG, scorers, MCP) | TS-native and stable since Jan 2026; gives the specialist capabilities their structure — Zod tool schemas, step retries, branching, suspend/resume — without LangChain-style indirection. Built on the AI SDK, so nothing changes underneath |
| Model layer under Mastra | **AI SDK v5 providers** via **Vercel AI Gateway** (primary) + **OpenRouter** (fallback) | Two-gateway failover exactly as AceBuilder runs it; both are plain APIs and work fine off-Vercel |
| Direct SDKs where features demand | **Anthropic SDK** (prompt caching, Batch API, extended context) | Brand/client context packs are ideal prompt-cache targets; Batch API halves full-source analysis cost |
| Model tiering | **Haiku 4.5** — broad cheap passes (chapterization, first-pass candidate scan, classification) · **Sonnet 5** — writing, adaptation, reranking, evaluators · **Opus 5 / Fable 5** — campaign planning, editorial judgment, brand-conflict reasoning | Tiered processing per thesis §27.2; routing table lives in config, per-task, per-tenant overridable |
| Embeddings | **voyage-3-large** (primary) via adapter | Transcript/moment/asset semantic search |
| Reranking | **Cohere Rerank** | Cheap quality boost on retrieval before context assembly |
| Context assembly | Custom `packages/ai/context` — purpose-specific context packs (org/client/brand/project/source scopes) with precedence hierarchy, versioned snapshots, per-item provenance — injected into Mastra agents as runtime context | Thesis §11 — the differentiator; every generation records which context snapshot it used |
| Prompt management | **Langfuse** (prompt registry, versioning, staged rollout) | Self-hostable (runs on Dokploy); prompts are governed product config (§21.7), not code literals |
| Tracing & evals | **Mastra scorers + OTel export → Langfuse** traces + datasets; **promptfoo** in CI for regression gates | Thesis §23: trace every run (context, tools, cost, latency, human decision); golden datasets per capability (moment acceptance, grounding, brand adherence) |
| Guardrails | Deterministic checkers first (claim-grounding linkage, prohibited-term scan, safe-zone/duration validators) + model evaluators second | Cheap deterministic gates before expensive model judges |
| Memory & learning | Mastra conversation memory (Postgres storage adapter) for copilot threads; **governed brand memory stays in our domain tables** (`brand_memory`, `feedback_signals`, classified per thesis §24.5) — **never** silent fine-tuning; suggestions surface for human approval | Memory is inspectable, editable, scoped, expirable (§24.6); framework memory and product memory are different things |

**Division of labor with Trigger.dev (§8):** Mastra workflows orchestrate the *AI steps inside a capability* (analyze → extract → score, with suspend/resume for in-capability gates). Trigger.dev remains the outer spine — infra-durable, long-running, machine-heavy jobs (ingest, render, publish) that *call* Mastra capabilities as steps. One job infrastructure, one agent framework; Mastra's alternate workflow engines (e.g. Inngest) stay unused.

**Anti-choice:** LangChain/LangGraph/CrewAI — Mastra covers the same ground TS-natively with less indirection, and the outer workflow graph stays deterministic in Trigger.dev either way.

---

## 8. Durable workflow runtime

Thesis §28.1 is a hard requirement list: checkpointing, resume, idempotency, human wait-states, scheduled future execution, compensation, replay. This cannot live in HTTP request handlers.

| Slot | Pick | Why |
|---|---|---|
| Orchestration | **Trigger.dev v4** (cloud now, self-host option later) | TypeScript-native durable tasks in-repo; long-running jobs with checkpoints; **waitpoints for human-in-the-loop approval gates**; scheduling; retries/backoff; Realtime API streams job progress straight into the UI; runs FFmpeg/Remotion/Playwright on large machines — one system covers AI orchestration *and* media compute |
| Heavy Python/GPU steps | **Modal**, invoked from Trigger.dev tasks | Right tool per workload; both scale to zero |
| Queues | Trigger.dev queues + concurrency keys per org/client | Fair scheduling and per-tenant concurrency caps without running Redis/BullMQ |
| Graduation path | **Temporal** if/when workflow volume and compliance demand it | Same conceptual model (durable execution + signals); adapters keep task bodies portable. Don't start here — ops burden is real |

Idempotency keys on every externally-visible effect (renders, publishes, ledger entries, exports) live in the domain layer regardless of runtime.

---

## 9. Data layer

| Slot | Pick | Why |
|---|---|---|
| Primary database | **Postgres on Neon** | Branch-per-PR dev workflow, serverless driver for Next, autoscaling; pgvector supported. (PlanetScale Postgres — AceBuilder's home — is the credible alternative at scale) |
| ORM | **Drizzle ORM** + drizzle-kit migrations | Typed SQL-first schema; AceBuilder-proven; plays well with RLS |
| Tenant enforcement | **Postgres RLS** on `organization_id` (+ client-scoped policies), session-scoped via `set_config` per request/task | Isolation enforced in the database, tested with automated cross-tenant probes (§34.1) |
| Content graph | Typed tables per node class + one **typed edge table** (`edge_type`, `from_id`, `to_id`, metadata JSONB) | The graph is relational lineage, not a graph-DB problem; recursive CTEs handle lineage traversal. No Neo4j |
| Vector search | **pgvector** (per-tenant partial indexes) | One database to operate; Turbopuffer only if scale forces it |
| Full-text search | **Postgres FTS** now → **Typesense/Meilisearch** when universal search (§29) needs faceting at scale | Hybrid = FTS + pgvector + Cohere rerank fused in the app |
| Cache / ephemeral | **Upstash Redis** | Rate limits, session-ish ephemera, hot entitlement checks. Deliberately small — Trigger.dev removed the queueing reason AceBuilder needed Redis for |
| Analytics warehouse | Postgres now → **ClickHouse (via Tinybird or ClickHouse Cloud)** when social-metric time series and event volume grow | Normalized analytics layer (§27.1) with raw + normalized metric retention |
| Usage/credit ledger | **Append-only Postgres tables**, corrections as compensating entries, unique correlation IDs | Money-adjacent data stays transactional (§32.3); AceBuilder blueprint's constraint verbatim |
| Object storage | **Cloudflare R2** (+ lifecycle tiers for archive/cold, §22.7) | Zero egress; signed, expiring access URLs only |
| File delivery | **Cloudflare CDN + Cloudflare for SaaS** (custom hostnames for white-label portals) | Custom client-portal domains (§25.1) with managed certs |

**Anti-choice: Convex as the system of record.** Convex's reactive queries, TS-native functions, built-in scheduler, and realtime sync are genuinely attractive for the collaborative surfaces — but Mitosia's canonical store is dominated by concerns Postgres handles better: structural tenant isolation (RLS + automated cross-tenant tests, §34.1, vs. code-enforced checks in every function), append-only money-adjacent ledgers, entitlement math, lineage traversal over a typed edge graph (recursive CTEs), heavy reporting/BI, warehouse export, and a future public API — all deep SQL-ecosystem territory (Drizzle, pgvector, ClickHouse connectors, BI tooling). Running Convex *alongside* Postgres would split the source of truth, which is worse than either alone. The itch Convex scratches is already covered slot-by-slot: reactive collab = Yjs/Liveblocks (§4, purpose-built CRDTs for the canvas), live job progress = Trigger.dev Realtime, reactive lists = TanStack Query invalidation. Revisit only for a self-contained realtime side-surface, never for the graph, ledger, or approvals.

---

## 10. Identity, access, multi-tenancy

| Slot | Pick | Why |
|---|---|---|
| AuthN | **Better Auth** + plugins: organization, passkey, 2FA, magic-link, SSO (OIDC/SAML) | AceBuilder-proven, extensible, self-owned user table in our Postgres; covers §7.1 including passkeys/MFA |
| Enterprise directory | **WorkOS** (SCIM + audit-log export) when enterprise deals require it | Buy the SCIM slog; Better Auth remains the session layer |
| AuthZ | Custom policy package (`packages/authz`) — role × scope (org/client/brand/campaign/project/asset) × action, CASL-style ability checks, deny-by-default | The §40 matrix is explicit; encode it as data + policy functions with a permission-preview mode. Graduate to **OpenFGA/SpiceDB** (ReBAC) when custom roles + inheritance exceptions outgrow tables |
| Guest/review links | Signed, expiring, scope-limited tokens (view/comment/approve), watermark flags | §34.10 secure external sharing |
| Secrets | Dokploy-managed env for the app; **Infisical** (self-hosted on Dokploy or cloud) as the shared vault across app/workers/CI; per-tenant integration credentials encrypted (AES-GCM, KMS-wrapped keys) | Social tokens are crown jewels; never in task logs or images |

---

## 11. Billing, entitlements, usage

**Constraint:** Mitosia's operating entity is India-registered — Stripe is effectively unavailable (India onboarding is invite-only), and recurring cross-border card billing from an Indian entity carries RBI e-mandate friction. That makes **merchant-of-record the right architecture, not a compromise**: the MoR is the legal seller, owns global sales tax/VAT, chargebacks, and localized payment methods (including UPI).

| Slot | Pick | Why |
|---|---|---|
| Payments/subscriptions | **Dodo Payments (MoR)** | AceBuilder-proven, India-friendly onboarding/payouts. As of 2026 it natively covers what Stripe Billing was originally picked for: usage meters with event ingestion and aggregation, credits with rollover/expiry/overage, hybrid subscription+usage plans, automated invoicing, customer portal |
| Enterprise second rail (later) | **Paddle** (mature MoR, 200+ sell-to countries, invoicing for larger B2B deals) — or a **US entity + Stripe** if enterprise procurement (POs, ACH/wire, custom MSAs) becomes the sales motion | A company-structure decision, not a stack decision; `packages/billing` keeps the seam so the swap is an adapter |
| Entitlement engine | **In-house** (`packages/billing/entitlements`): feature flags + quantitative limits + period pools + rollover/overage rules, real-time checks with cached reads | §32.2 is product logic (client pools, reserved capacity, explain-why-blocked) no vendor models well |
| Usage metering | In-house append-only ledger (§9) with org/client/brand/project/job/user dimensions; pre-action estimates + reservations. Dodo's meters are fed *from* our ledger, never the reverse | The ledger powers bill-back, margin, budgets (§32.4-32.8) and must survive any billing-vendor swap |
| Client bill-back & profitability | In-house reports over ledger + time tracking | Core differentiation for agency ops — never outsource |

Watch-items on Dodo: the MoR fee premium over a raw gateway is the price of tax/compliance/chargeback offload — acceptable at SaaS margins; verify payout cadence and enterprise invoice terms as deal sizes grow.

---

## 12. Integrations & publishing

| Slot | Pick | Why |
|---|---|---|
| OAuth/token lifecycle | **Nango** (open-source, self-hostable) | Handles OAuth dances, token refresh, credential storage for hundreds of APIs — the undifferentiated 60% of every connector |
| Publishing adapters | **In-house per platform** (LinkedIn, X, YouTube, TikTok, Instagram/Meta, podcast/RSS, newsletter, CMS, DAM…) behind one orchestration interface with capability discovery | Thesis §25: a common interface must *not* erase platform differences; publish reliability is core product. No Ayrshare-style aggregator — it becomes the product's ceiling |
| Publish execution | Trigger.dev durable tasks: preflight (§26.6) → idempotent publish → verify → receipt with remote ID/URL | No duplicate posts, no stale-version publishes — reliability goals §28.3 |
| Analytics retrieval | Same adapters, scheduled collection into warehouse | Source-to-performance lineage keys on publication receipts |
| Outbound webhooks | **Svix** | Signing, retries, replay, endpoint management (§30.5) — classic buy |
| Inbound automation | Generic webhook triggers + **QStash/Trigger.dev schedules** | §21 automation builder executes on the same runtime as recipes |

---

## 13. Notifications & email

| Slot | Pick | Why |
|---|---|---|
| Notification infrastructure | **Knock** (managed) or **Novu** (self-host) — decide on pricing at adoption time | §31 is an entire product (channels, preferences, digests, batching, escalation); classic buy |
| Transactional email | **Resend + react-email** | Modern DX; per-tenant branded sending domains for white-label portals |
| Mobile/browser push | Expo push (companion app) + web push via notification infra | §31.3 |

---

## 14. Observability, analytics, quality

| Slot | Pick | Why |
|---|---|---|
| Errors | **Sentry** (web + workers) | Table stakes |
| Logs/traces/metrics | **OpenTelemetry** → **Axiom** (or Grafana Cloud) | Correlation ID from user action → job → provider call → ledger entry (§42.9) |
| AI traces/evals | **Langfuse** (§7) | One place for prompts, traces, datasets, scores |
| Product analytics | **PostHog** (+ feature flags + session replay) | Activation/time-to-value metrics (§44) and flags/kill-switches (§36.8) in one vendor |
| Uptime/status | **BetterStack** status page + monitors | Client-facing incident status (§28.2) |
| Testing | **Vitest** (unit/service), **Playwright** (E2E incl. proofing/portal flows), golden media fixtures for render determinism, promptfoo eval gates in CI | §42.6-42.7 media + AI quality harnesses |

---

## 15. Hosting, CI/CD, repo structure

| Slot | Pick | Why |
|---|---|---|
| App hosting | **Hostinger VPS (KVM) + Dokploy** | Self-hosted PaaS: Git auto-deploy, native Docker/Compose, Traefik + Let's Encrypt, PR preview deployments (app-level), multi-server management over SSH, built-in monitoring/logs. The AceBuilder Hetzner+Coolify pattern, adopted from day one on cheaper boxes |
| Edge/CDN/WAF | **Cloudflare** in front — DNS, CDN, WAF/DDoS (R2 is already there); **Cloudflare for SaaS** for white-label portal domains | The VPS never faces raw internet traffic; media egress rides R2/CDN, not the VPS NIC |
| Next.js runtime | **Standalone output in Docker** (Node + sharp for image optimization) | Self-hosted Next 16 is fully supported; nothing Vercel-only in scope |
| Adjacent services on Dokploy | **Langfuse, Nango, Infisical** now; **Hocuspocus / Novu / Typesense** later as their slots mature | Big synergy: every "self-host graduation path" in §4/§12/§13 becomes a Dokploy container instead of a new vendor |
| Jobs/media compute | **Trigger.dev cloud** + **Modal** now; self-hosted Trigger.dev on a dedicated worker VPS is the documented cost graduation | Keep heavy compute off the app box |
| Database | **Neon stays managed** | Don't self-host the system of record — PITR, backups, and branch-per-PR are worth more than the VPS savings; revisit only at real scale |
| CI/CD | **GitHub Actions** (typecheck, Ultracite, Vitest, Playwright, promptfoo) → Docker image → **GHCR** → Dokploy auto-deploy; Dokploy PR previews + **Neon branch-per-PR** | A Vercel-preview-like flow, self-hosted |
| Sizing & ops | Start on one KVM 8-class box (8 vCPU / 32 GB) with snapshots + off-box backups enabled; unattended-upgrades + fail2ban; add a second box for workers when queue depth demands (Dokploy multi-server) | We own patching/monitoring now — that's the trade for the bill; Dokploy + Cloudflare absorb most of it |
| Monorepo | **pnpm workspaces + Turborepo** — adopt when the second deployable (trigger tasks / public API) lands, not before | Avoid ceremony until it pays |

Target layout (adapted from the AceBuilder blueprint):

```text
apps/
  web/            # Next.js app: studio, portal (route groups), admin
  api/            # Hono public API (later)
  mobile/         # Expo companion app (later)
packages/
  ui/             # shadcn-based design system
  db/             # Drizzle schema, migrations, RLS policies, repositories
  authz/          # roles, scopes, ability checks, permission preview
  ai/             # harness: context assembly, capabilities, routing, guardrails
  media/          # ffmpeg/probe/edit-spec/render adapters, Remotion project
  workflows/      # Trigger.dev tasks: ingest, analyze, generate, render, publish
  integrations/   # Nango config + per-platform publish/analytics adapters
  billing/        # Stripe adapter, entitlements, usage ledger
  notifications/  # Knock/Novu + Resend templates
  contracts/      # Zod schemas & shared types (single source of truth)
```

---

## 16. Security & compliance baseline

- **RLS everywhere** + automated cross-tenant isolation tests in CI (§34.1).
- Signed, short-lived media URLs; watermarked review renders; download controls (§34.3, §29.2).
- Append-only audit log table (auth, permission, approval, publish, export, support-access events) with export stream; WorkOS Audit Logs at enterprise tier (§34.4).
- AI data governance: provider allowlist per tenant, no-training flags, regional routing config, redaction pass before model calls where policy requires; embeddings/caches deleted with source (§34.7).
- Rights/consent as first-class tables that can **block** generation, export, publish independently of workflow status (§41.12).
- SOC 2 posture from the start: **Vanta** once the first enterprise conversation begins, not before.

---

## 17. AceBuilder adoption map

| AceBuilder choice | Mitosia verdict | Note |
|---|---|---|
| Next.js + React + Tailwind + shadcn/ui + Motion | **Adopt** | Already in repo |
| Zustand + TanStack Query + nuqs + cmdk + Sonner + Vaul + Recharts | **Adopt** | Same roles |
| Lexical | **Replace → Tiptap** | Collaborative docs with track-changes outweigh prompt-editor ergonomics; Tiptap mentions cover the `@` pattern |
| Monaco + Shiki | **Downscope → CodeMirror + Shiki** | No full IDE surface in Mitosia |
| AI SDK + two gateways + auto/manual model routing | **Adopt, wrapped by Mastra** | Mastra 1.0 sits on the AI SDK; gateways + direct Anthropic SDK (caching/Batch) unchanged underneath |
| Custom agent harness | **Adopt philosophy** | Ours is the whole product: content graph + bounded capabilities + evals |
| PlanetScale Postgres | **Adapt → Neon** | Branching DX + pgvector now; PlanetScale remains scale option |
| Redis for sandbox state | **Downscope → Upstash for cache/ratelimit** | Trigger.dev owns queue/state |
| Drizzle ORM | **Adopt** | |
| Better Auth | **Adopt** | + org/passkey/SSO plugins, WorkOS for SCIM later |
| Dodo Payments | **Adopt** | MoR + native usage billing/credits/invoicing; the right architecture for an India-registered seller (Stripe unavailable). Paddle or US-entity+Stripe as enterprise second rail later |
| AutoSend | **Replace → Resend** | react-email templates, tenant domains |
| Daytona sandboxes | **Not needed** | We don't execute untrusted generated code; our isolation problem is media + tenants |
| Cloudflare R2 | **Adopt** | Even more decisive for video |
| Hetzner + Coolify | **Adopt in spirit, day one → Hostinger VPS + Dokploy** | Same self-hosted-PaaS pattern; Cloudflare in front; Neon stays managed |
| Build-vs-buy doctrine | **Adopt wholesale** | See §1 |

**Net-new subsystems AceBuilder never needed:** durable workflow runtime (Trigger.dev), media pipeline (FFmpeg/Remotion/Modal), real-time collaboration (Yjs/Liveblocks), transcription/CV providers, publishing adapter framework (Nango + custom), notification infra (Knock/Novu), entitlement engine + usage ledger, RLS multi-tenancy, warehouse path (ClickHouse).

---

## 18. Phased adoption

**Phase 1 — Foundation:** Dokploy on Hostinger VPS (app + Langfuse + Nango + Infisical containers, Cloudflare in front), monorepo, Drizzle schema for org→client→brand→campaign→project→source graph + RLS, Better Auth (orgs, passkeys), R2 + Uppy ingest, Trigger.dev skeleton (probe→proxy→transcribe), Deepgram adapter, transcript viewer, Mastra + Langfuse wiring, usage ledger writes from day one.

**Phase 2 — Understanding & curation:** Source intelligence passes (chapters/topics/claims/quotes via tiered Claude calls + Batch), moment candidates + scoring + review UI (card/transcript/timeline), pgvector semantic search, context-assembly v1 (brand/client packs with prompt caching).

**Phase 3 — Production:** Edit-spec model + transcript-based cutting, Remotion caption/brand templates + render tiers, written studio (Tiptap + grounded generation with evidence links), quote cards (Satori), variants model, React Flow canvas over the graph, Liveblocks presence/comments.

**Phase 4 — Governance & delivery:** Review/approval engine (version-pinned, §24.6 invariants), client portal (white-label, Cloudflare for SaaS), Nango + first publish adapters (LinkedIn, YouTube, X) with preflight/verify, calendar/scheduling, notifications (Novu on Dokploy or Knock), Dodo billing + entitlements enforcement.

**Phase 5 — Intelligence & scale:** Analytics collection → warehouse, source-to-performance lineage dashboards, brand memory + learning loops with approval UX, recipes/automation builder, public API (Hono + OpenAPI) + Svix webhooks, evals-gated prompt rollout, enterprise (SSO/SCIM, audit export, residency options).

---

## 19. Open decisions (owner call needed)

1. **Polotno SDK license vs building the design studio on Konva** — prototype with Polotno's trial before committing.
2. **Liveblocks (managed) vs Hocuspocus (self-host on Dokploy)** — decide on projected MAU pricing when collab ships; Dokploy lowers the self-host barrier.
3. **Knock vs Novu** — Novu self-hosted on Dokploy is the cost-consistent default; Knock if notification complexity outpaces ops appetite.
4. **Mux vs self-managed HLS on R2** — default is self-managed (cost); Mux buys player analytics + instant clipping if pipeline velocity lags.
5. **Enterprise billing second rail** — Paddle vs US entity + Stripe; decide when the first PO/wire-transfer enterprise deal appears, not before.
6. **Trigger.dev cloud → self-host timing** — move workers to a dedicated VPS when cloud spend exceeds the cost of a second box plus the ops attention it demands.
