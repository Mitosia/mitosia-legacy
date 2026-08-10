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
npx trigger.dev@latest login
npx trigger.dev@latest dev   # runs trigger/ tasks locally, orchestrated by the cloud
```

With `TRIGGER_SECRET_KEY` set, `enqueueIngest()` automatically switches
from the in-process fallback to `tasks.trigger("ingest-source", …)`.

### Deploying the task

```bash
TRIGGER_PROJECT_REF=proj_… npx trigger.dev@latest deploy
```

`trigger.config.ts` already includes the **ffmpeg build extension**, so the
cloud image has ffmpeg/ffprobe. Later, add a deploy step to the GitHub
Actions workflow (needs a `TRIGGER_ACCESS_TOKEN` personal access token as a
repo secret) so tasks deploy on merge alongside the app.

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
