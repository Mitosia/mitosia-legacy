<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Mitosia Project Rules

Read [docs/tech-stack.md](docs/tech-stack.md) (stack decisions and rationale) and [docs/sprint-plan.md](docs/sprint-plan.md) (build sequence) before architectural work. Record new durable decisions in this file.

## Git workflow

- **Never commit or push directly to `main`.** All work lands through a pull request: branch → commit → push → open PR → CI green → merge. This holds for docs and one-line fixes too.
- Branch names: `feat/…`, `fix/…`, `chore/…`, `docs/…`.
- CI (lint, typecheck, build) must pass before merge. Merging to `main` deploys to staging, so a red build is a broken staging environment.
- `production` is promoted only by fast-forwarding from `main` — never a direct commit, never a PR target for feature work.

## Environments and deployment

- `main` = staging → auto-deploys to https://staging.mitosia.cloud (Dokploy, Dockerfile build on the VPS).
- `production` = prod → https://app.mitosia.com. Promote by fast-forwarding `production` to `main` — never commit directly to `production`.
- The `mitosia.com` apex is reserved for the future marketing site; the product lives at `app.mitosia.com`. `mitosia.com` DNS goes behind Cloudflare (CDN/WAF) when prod ships; `mitosia.cloud` stays on plain Hostinger DNS deliberately (simple Let's Encrypt issuance).
- `mitosia.cloud` is the infra domain: Dokploy panel at dokploy.mitosia.cloud; wildcard `*.mitosia.cloud` already points at the VPS, so new services need zero DNS work.
- Dokploy layout: one project `mitosia` containing two environments — `staging` (app + its own Postgres service, tracks `main`) and `production` (app only, tracks `production` branch, database on Neon). Services are isolated per environment; never point a staging service at production data.
- VPS: Hostinger KVM 8 at 72.61.169.154, SSH alias `mitosia-vps` (key auth). ufw allows only 22 (rate-limited), 80, 443. The Dokploy panel's port 3000 must stay unpublished — Docker-published ports bypass ufw, so re-verify after any Dokploy self-update.
- Secrets are per-environment: separate `BETTER_AUTH_SECRET` and `DATABASE_URL` for dev/staging/prod, injected as runtime env in Dokploy — never baked into the Docker image or committed. Staging DB: Dokploy-provisioned Postgres on the VPS. Production DB: Neon (managed, PITR).

## Local development

- Dev Postgres: `docker compose up -d`, host port **55433**. Do not "simplify" this to 5432/5433: 5432 is a native Homebrew Postgres, and the IPv4 side of 5433 belongs to a Podman VM hosting Postgres for **kaera** (a separate project — never stop or modify the Podman machine).
- Dev object storage: MinIO from the same compose file — S3 API on **55490**, console on **55491**, bucket `mitosia-media` auto-created. Deployed environments use Cloudflare R2 through the identical S3 adapter (`lib/storage`); only `STORAGE_*` env changes. R2 buckets need a CORS rule exposing `ETag` or browser multipart uploads cannot complete.
- Dev server runs on port 3001 (`.claude/launch.json`); `BETTER_AUTH_URL` must match the served origin or logins fail origin checks.
- `.env` is gitignored; update `.env.example` whenever env vars change.
- The ingest pipeline shells out to **ffmpeg/ffprobe** — required on dev machines (`brew install ffmpeg`) and installed in the Docker image. The e2e suite needs docker compose services up plus ffmpeg.

## Media pipeline (S2 decisions)

- Storage keys: `org/{orgId}/client/{clientId}/source/{sourceId}/…` — the `org/` prefix is the authorization boundary. Media reaches the browser only through `/api/media/[...path]`, an authenticated same-origin streaming proxy that rejects keys outside the caller's active org. No public/presigned URLs in the client; the R2+CDN signed-URL path arrives with client delivery (S18).
- Ingest runs through one seam: `enqueueIngest()` (lib/ingest.ts). With `TRIGGER_SECRET_KEY` set it triggers the durable Trigger.dev task (`trigger/ingest-source.ts`); without it the pipeline runs in-process after the response (dev fallback — dies with the server, documented, not for real workloads). Pipeline steps and their ffmpeg invocations live in `lib/media/`; the claim step makes re-enqueues and retries idempotent.
- Usage ledger (`usage_ledger`) is append-only **by policy shape**: it has only SELECT and INSERT RLS policies, so UPDATE/DELETE are database-denied even in-org. Writers must be idempotent via `correlation_id` (unique); corrections are compensating entries. Anything metered writes to the ledger in the sprint it ships — never retrofitted.
- ffmpeg 8 quirks encoded in `lib/media/`: mjpeg outputs need `format=yuvj420p` (limited-range YUV is rejected), and `fps=1/N` needs `:round=up` or sources shorter than N seconds emit zero thumbnails. Don't "clean up" those filter args.
- Rendition ladder (`lib/media/hls.ts`) follows platform practice deliberately: native-resolution top rung (≤1080p, capped CRF per Apple's peak≤200%-of-average VOD rule, `fast` preset) over 720p/360p proxies, 2s keyframes, High profile, 1.5× caps for >40fps sources; the player starts at the top rung. The 234p–480p cellular rungs and multi-codec (VP9/AV1) are deferred until client delivery (S18) — don't add them to the review path.
- The source player (`components/sources/source-player.tsx`) encodes two hard-won ordering rules in its header comment: client-only mount (media-chrome upgrade vs React hydration) and peaks-before-hls init (peaks calls `mediaElement.load()`, fatal after a MediaSource attach since MSE object URLs are single-use). The ingest e2e's full-document-load assertion guards the SSR half; don't reorder those stages. Peaks.init additionally waits for the overview container to have layout (`waitForLayout`) — zero-width init (hidden tab, prerender) throws and used to hide the waveform permanently.
- Waveform peaks (`lib/media/peaks.ts`) must span the **media** duration, not the audio stream: sources whose audio ends early are padded with silent buckets, and `samples_per_pixel` scales with duration to target a ~4096px native width. Both are load-bearing for the overview timeline: peaks.js maps pixels to time through the data's implied duration and cannot upsample, so audio-length or too-short data desynchronizes the waveform x-axis from the video timeline (wide windows: truncated-looking waveform; narrow: playhead pegged early). Don't regress to a fixed `samples_per_pixel`.

## Tenancy and RLS (load-bearing security rules)

- Tenant-owned tables (anything with `organization_id`) get `ENABLE` + `FORCE ROW LEVEL SECURITY` and an org-isolation policy **in the same migration that creates them**, and an entry in `tests/rls-isolation.test.ts`.
- App code touches tenant tables **only** inside `withOrgScope()` (`lib/db/tenant.ts`), with the org id taken from `requireOrg()` — never from user input.
- The app's `DATABASE_URL` role must **never** be a superuser or table owner: superusers bypass RLS silently, and the Docker image's `POSTGRES_USER` is a superuser. The app connects as `mitosia_app`; `MIGRATE_DATABASE_URL` carries the owner connection used only by drizzle-kit and the container entrypoint.
- Foreign-key checks do not consult RLS. Before inserting a child row, re-read the parent inside the org scope (see `assertVisible` in `lib/actions/hierarchy.ts`) so a cross-tenant parent id can never be attached.
- Tests: `TEST_DATABASE_URL` must point at a disposable database (the suite wipes it); run with `pnpm test`.

## UI (hard rule)

- **Never build UI components from scratch.** Before writing any UI, search the shadcn registry for an official component or block that fits (`pnpm exec shadcn add <name>`; blocks like `sidebar-07`, login/dashboard blocks, etc.) and adapt it. Composing registry primitives into domain components is fine; hand-rolling layout/navigation/form primitives that the registry already provides is not.
- **When adapting a registry block, keep its structural wrappers.** Base UI parts are context-coupled: `Menu.GroupLabel`/`DropdownMenuLabel` must stay inside a `Menu.Group`/`DropdownMenuGroup`, etc. Dropping a wrapper compiles fine and then crashes at runtime when the menu opens (e.g. "MenuGroupContext is missing"). This is exactly why the registry-first rule exists.
- **Interactive UI must be exercised by an e2e test.** Any menu, dialog, popover, or dropdown that can be opened gets a Playwright test in `e2e/` that opens it and asserts no `pageerror`. A visual/manual sweep is not sufficient — Base UI context crashes only fire on interaction. Run with `pnpm e2e` (dev server on 3001; `BETTER_AUTH_URL` must match that origin).
- The only exception is genuinely novel domain UI with no registry equivalent (e.g. the campaign canvas, transcript editor) — and even those must be built out of registry primitives wherever possible. Note the exception in the PR description when it applies.
- This registry uses the Base UI variant: composition is via the `render` prop, not `asChild`. Icons come from `@hugeicons/core-free-icons` (ESM-only — check names with an ESM import, not `require`).

## Conventions

- The auth schema is generated: `pnpm db:auth:generate` (Better Auth CLI). Never hand-edit `lib/db/schema/auth.ts`.
- Schema changes ship as migrations: `pnpm db:generate` to author them, `pnpm db:migrate` to apply locally. No `drizzle-kit push` against shared databases.
- Deployed environments migrate themselves: `docker-entrypoint.sh` runs the bundled `scripts/migrate.ts` (advisory-locked, idempotent) before starting the server, and a failed migration aborts the container so the deploy fails loudly. Never run migrations during `docker build` — the image must stay environment-agnostic and build-time has no real database.
- `components/ui/**` is vendored shadcn registry output — lint-exempt (see biome.jsonc), regenerated via the shadcn CLI, not hand-maintained.
- `proxy.ts` performs optimistic redirects only. Authorization lives in server components and route handlers, never in the proxy.
