<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Mitosia Project Rules

Read [docs/tech-stack.md](docs/tech-stack.md) (stack decisions and rationale) and [docs/sprint-plan.md](docs/sprint-plan.md) (build sequence) before architectural work. Record new durable decisions in this file.

## Environments and deployment

- `main` = staging → auto-deploys to https://staging.mitosia.cloud (Dokploy, Dockerfile build on the VPS).
- `production` = prod → https://app.mitosia.com. Promote by fast-forwarding `production` to `main` — never commit directly to `production`.
- The `mitosia.com` apex is reserved for the future marketing site; the product lives at `app.mitosia.com`. `mitosia.com` DNS goes behind Cloudflare (CDN/WAF) when prod ships; `mitosia.cloud` stays on plain Hostinger DNS deliberately (simple Let's Encrypt issuance).
- `mitosia.cloud` is the infra domain: Dokploy panel at dokploy.mitosia.cloud; wildcard `*.mitosia.cloud` already points at the VPS, so new services need zero DNS work.
- VPS: Hostinger KVM 8 at 72.61.169.154, SSH alias `mitosia-vps` (key auth). ufw allows only 22 (rate-limited), 80, 443. The Dokploy panel's port 3000 must stay unpublished — Docker-published ports bypass ufw, so re-verify after any Dokploy self-update.
- Secrets are per-environment: separate `BETTER_AUTH_SECRET` and `DATABASE_URL` for dev/staging/prod, injected as runtime env in Dokploy — never baked into the Docker image or committed. Staging DB: Dokploy-provisioned Postgres on the VPS. Production DB: Neon (managed, PITR).

## Local development

- Dev Postgres: `docker compose up -d`, host port **55433**. Do not "simplify" this to 5432/5433: 5432 is a native Homebrew Postgres, and the IPv4 side of 5433 belongs to a Podman VM hosting Postgres for **kaera** (a separate project — never stop or modify the Podman machine).
- Dev server runs on port 3001 (`.claude/launch.json`); `BETTER_AUTH_URL` must match the served origin or logins fail origin checks.
- `.env` is gitignored; update `.env.example` whenever env vars change.

## Conventions

- The auth schema is generated: `pnpm db:auth:generate` (Better Auth CLI). Never hand-edit `lib/db/schema/auth.ts`.
- Schema changes ship as migrations: `pnpm db:generate` then `pnpm db:migrate`. No `drizzle-kit push` against shared databases.
- `components/ui/**` is vendored shadcn registry output — lint-exempt (see biome.jsonc), regenerated via the shadcn CLI, not hand-maintained.
- `proxy.ts` performs optimistic redirects only. Authorization lives in server components and route handlers, never in the proxy.
