# Runbook: moving the CI e2e job to a 4-core larger runner

The e2e job is CPU-bound (parallel Playwright workers + `next dev` + in-process
ffmpeg ingest pipelines on the standard runner's 2 vCPUs), and 2-vCPU
noisy-neighbor variance is large — identical code measured 154s / 200s / 268s
for the same test step across three green runs (PRs #62/#66, 2026-08-24). A
4-core larger runner both shortens the job (~3 minutes expected end to end)
and compresses that variance.

Everything is pre-wired: the workflow reads the **`E2E_RUNNER` repository
variable** (`runs-on: ${{ vars.E2E_RUNNER || 'ubuntu-latest' }}`), and
Playwright derives its worker count from the runner's vCPUs
(`os.availableParallelism() - 1`, floor 2, cap 4 — playwright.config.ts). So
enabling this is org-admin clicks plus one variable; no code change, and
rollback is deleting the variable.

Only the `e2e` job moves. `checks` (cache-warm 13s builds), `changes`, and
`deploy-trigger` stay on `ubuntu-latest` deliberately — none of them is
CPU-bound.

## Prerequisites (org admin)

1. **Billing.** Larger runners bill per-minute from the first minute and are
   NOT covered by the free included minutes. Critically, the org's **Actions
   spending limit must be above $0** — the default is $0, which blocks larger
   runners entirely (jobs never start). Org **Settings → Billing and
   licensing → Spending limits → Actions**: set a monthly limit (e.g. $20).
2. **Plan.** Larger runners need GitHub Team or Enterprise Cloud. This org is
   on Team (verified 2026-08-24).

## Create the runner

Org **Settings → Actions → Runners → New runner → New GitHub-hosted runner**:

- **Name**: `ubuntu-4-core` — the name IS the `runs-on` label.
- **Platform**: Linux x64. **Image**: Ubuntu 24.04 (matches `ubuntu-latest`,
  so the Chrome-libraries assumption behind our lean Playwright install
  holds). **Size**: 4-core.
- **Runner group**: Default is fine, but open **Runner groups → Default →
  Repository access** and confirm it allows this repository (or all
  repositories, including private).

Newer Team orgs sometimes come with preprovisioned larger runners already
listed on that page — if a Linux 4-core one exists, reuse its name instead of
creating another.

## Flip the switch

```bash
gh variable set E2E_RUNNER --repo Mitosia/mitosia --body ubuntu-4-core
```

(or repo **Settings → Secrets and variables → Actions → Variables → New
repository variable**). Variables, not secrets — `runs-on` can only read
`vars.*`, the same reason the Trigger deploy switch (`TRIGGER_PROJECT_REF`)
is a variable.

## Verify

On the next code push, the `e2e` job header in the run page names the runner.
Expect: Playwright reports `using 3 workers`, the test step lands around
90–150s, and the job finishes in ~2.5–3 minutes. Docs-only pushes still skip
the job entirely, so they cost nothing on the paid runner.

## Troubleshooting

- **Job sits at "Waiting for a runner"** (more than ~2 minutes): the label
  doesn't exist, the runner group doesn't include this repo, or the Actions
  spending limit is $0. `gh variable delete E2E_RUNNER --repo Mitosia/mitosia`
  falls straight back to `ubuntu-latest` while you investigate — a queued job
  is NOT bounded by `timeout-minutes` (that clock starts when the job starts),
  so don't wait it out.
- **Browser fails to launch** after an image change: reinstate `--with-deps`
  on the "Install Playwright browser" steps (see the comment there).

## Cost

Linux 4-core is $0.016/min (2× the standard overage rate). At ~3 min/run
that's ≈ $0.05 per code push; 30 code pushes/day ≈ $1.50/day. For comparison,
once the 2000 free monthly minutes are exhausted, today's ~5-minute e2e on the
standard runner already costs ≈ $0.04/push — the marginal cost of the upgrade
is small, and docs-only pushes (about half — see the `changes` job) skip e2e
entirely.
