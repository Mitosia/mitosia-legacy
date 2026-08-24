# Media infrastructure setup: R2 + Trigger.dev

What must exist in the real world before S2's ingest pipeline runs on
deployed environments. Local dev needs none of this — `docker compose up -d`
provides MinIO, and the in-process fallback runs the pipeline.

## 1. Cloudflare R2 (object storage)

The app talks plain S3 (`lib/storage`); only env values change between
MinIO and R2.

### Create the bucket

1. Cloudflare dashboard → **R2 Object Storage** (enable R2 on the account
   if this is the first bucket; the free tier covers staging comfortably).
2. **Create bucket** → name `mitosia-media-staging` (later: a separate
   `mitosia-media-prod`). Location: Automatic. Storage class: Standard.

### API token (S3 credentials)

1. R2 overview → **Manage R2 API Tokens** → **Create API Token**.
2. Permissions: **Object Read & Write**, scoped to *only* the one bucket.
3. Save the **Access Key ID** and **Secret Access Key** shown once, and
   note the account-level S3 endpoint:
   `https://<account_id>.r2.cloudflarestorage.com`.

### CORS (required for browser uploads)

Bucket → **Settings** → **CORS policy**. Browsers PUT upload parts directly
to presigned R2 URLs; everything else (create/complete/abort, all media
reads) goes through the app server and needs no CORS. Uppy must be able to
read each part's `ETag` response header — without `ExposeHeaders: ETag`,
multipart uploads stall at completion (this is the classic R2+Uppy trap):

```json
[
  {
    "AllowedOrigins": ["https://staging.mitosia.cloud"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Add the prod origin to the prod bucket's policy when it ships.

### Housekeeping rule

Bucket → Settings → **Object Lifecycle Rules**: R2 ships a "Default
Multipart Abort Rule" (abort incomplete uploads after 7 days, no prefix)
on new buckets — verify it is **Enabled** rather than creating one.
Abandoned browser uploads otherwise accumulate invisible storage forever.

Verify it from the repo instead of by eye — point `STORAGE_*` at the
bucket and run:

```bash
pnpm check:abort-rule
```

It exits non-zero when no enabled rule aborts incomplete multipart
uploads. This is the *backstop*, not the primary cleanup: the app sweeps
its own abandoned uploads after 24 idle hours (`reapStaleUploads` in
`lib/uploads.ts`, triggered by the project page), which both releases the
parts and stops the source row rendering as a permanently-uploading ghost.
The bucket rule catches what the sweep never sees.

### Wire into Dokploy (staging app service → Environment)

```
STORAGE_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
STORAGE_REGION=auto
STORAGE_ACCESS_KEY_ID=<token access key id>
STORAGE_SECRET_ACCESS_KEY=<token secret>
STORAGE_BUCKET=mitosia-media-staging
STORAGE_FORCE_PATH_STYLE=false
```

Redeploy. **Do this before merging S2 to `main`** — `lib/env.ts` validates
these at boot, so a deploy without them crash-loops the container.

Smoke test: upload a small video on staging, watch it reach **Ready**,
play it, and confirm objects under `org/…` appear in the bucket.

## 2. Trigger.dev (durable ingest runtime)

Without `TRIGGER_SECRET_KEY` the app runs ingest in-process after the
response — fine for dev/early staging, but it dies with the server process
and has no retry/backoff. Trigger.dev is the durable path.

### The reachability constraint (read first)

Trigger.dev **cloud** workers must reach the database over the internet.
Staging's Postgres is a Dokploy container on the VPS with ufw allowing only
22/80/443 — cloud workers **cannot reach it**. Realistic options:

1. **Defer** — staging keeps the in-process fallback; wire Trigger.dev for
   production, whose database (Neon) is publicly reachable with TLS. Zero
   work now.
2. **Neon for staging too** — a small free Neon database for staging makes
   staging's architecture match prod and unlocks Trigger.dev immediately.
   (Recommended when ingest reliability on staging starts to matter.)
3. Self-hosted Trigger.dev on the VPS — real ops burden; only at scale.

Do **not** expose the VPS Postgres port publicly.

### Account and project

1. Sign up at cloud.trigger.dev → create org **Mitosia** → create a
   **v4** project `mitosia`.
2. Project settings → copy the **project ref** (`proj_…`).
3. Each Trigger environment (Dev / Prod) has its own **secret key**
   (`tr_dev_…` / `tr_prod_…`) under **API Keys**.

### Local development against Trigger cloud (optional)

```bash
# .env: TRIGGER_PROJECT_REF=proj_…  and  TRIGGER_SECRET_KEY=tr_dev_…
# Pin the CLI to the @trigger.dev/sdk version in package.json (4.5.12 today) —
# CLI/SDK drift breaks deploys in confusing ways; never use @latest.
npx trigger.dev@4.5.12 login
npx trigger.dev@4.5.12 dev   # runs trigger/ tasks locally, orchestrated by the cloud
```

With `TRIGGER_SECRET_KEY` set, `enqueueIngest()` automatically switches
from the in-process fallback to `tasks.trigger("ingest-source", …)`.

### Deploying the task

Automatic (preferred): the `deploy-trigger` job in `.github/workflows/ci.yml`
deploys the tasks on every merge to `main`, after `checks` and `e2e` pass.
It is **skipped until two repository settings exist** (Settings → Secrets and
variables → Actions):

1. Variable `TRIGGER_PROJECT_REF` = the project ref (`proj_…`) — this is the
   opt-in switch; the job stays skipped while it is unset.
2. Secret `TRIGGER_ACCESS_TOKEN` = a personal access token (`tr_pat_…`) from
   the Trigger.dev dashboard (account → Personal Access Tokens). Setting the
   variable without the secret fails the job loudly — that half-state is a
   misconfiguration, not an opt-out.

The job derives the CLI version from `@trigger.dev/sdk` in `package.json`,
so a dependency bump moves CLI and SDK together.

Manual (fallback, and until the switch is set):

```bash
# CLI version pinned to match @trigger.dev/sdk in package.json.
TRIGGER_PROJECT_REF=proj_… npx trigger.dev@4.5.12 deploy
```

`trigger.config.ts` includes the custom **`pinnedFfmpeg` build extension**
(not the bundled `ffmpeg()`, which installs Debian's 5.1.x), so the cloud
image gets the same checksummed 8.1.x static build CI uses — mirrored on
this repo's own `ffmpeg-static/*` GitHub release (see the ffmpeg rules in
AGENTS.md and `scripts/ffmpeg-pin.mjs`).

> **Deploys need GitHub auth on the deploying machine.** Config-eval
> downloads the pinned archive from the private repo's release and ships
> it to Trigger's builders inside the image build context — the builders
> themselves can't reach a private release. The CI job passes
> `GH_TOKEN: ${{ github.token }}`; for a manual deploy, an authenticated
> `gh` (`gh auth status`) is enough. Without it the deploy aborts at
> config-eval with instructions, before anything is uploaded.

### Environment variables in the Trigger dashboard

The task imports `lib/env.ts`, which validates on import — the Trigger
environment therefore needs **all** of these (per environment):

```
DATABASE_URL=<Neon connection string — must be internet-reachable>
BETTER_AUTH_SECRET=<any 32+ char string; tasks never use it, validation requires it>
STORAGE_ENDPOINT / STORAGE_REGION / STORAGE_ACCESS_KEY_ID /
STORAGE_SECRET_ACCESS_KEY / STORAGE_BUCKET / STORAGE_FORCE_PATH_STYLE
```

### Flip the app over

In Dokploy (the environment being wired): add
`TRIGGER_SECRET_KEY=<matching env secret key>` and redeploy. Uploads now
enqueue durable runs; watch them in the Trigger.dev dashboard. Failures
still surface on the source row with the retry button, and Trigger's own
retry policy (3 attempts, exponential backoff) applies on top.

### Tuning, later

- Transcodes are CPU-bound: if two-hour 1080p sources run slow on the
  default machine, set `machine: "large-1x"` (or similar) on
  `ingestSourceTask` — measure first.
- Per-org fairness is already in place via `concurrencyKey` at trigger
  time; add a queue `concurrencyLimit` if one tenant's bulk upload should
  cap parallel transcodes.
