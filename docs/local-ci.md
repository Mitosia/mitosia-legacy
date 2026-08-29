# Local pull-request gate

Mitosia runs its complete pull-request validation on the developer machine
while the repository has one committer. GitHub Actions only verifies the
exact-commit attestation; it does not check out the repository or run tests.
This is the temporary cost-control policy recorded in `AGENTS.md`.

## One-time setup

Install dependencies and the versioned Git hook:

```bash
pnpm install --frozen-lockfile
```

The `prepare` script sets this checkout's `core.hooksPath` to `.githooks`.
The gate also requires Docker, ffmpeg/ffprobe 8.1.x, GitHub CLI authentication,
and Playwright Chromium. It starts the existing Postgres and MinIO compose
services but never wipes their normal database or bucket.

## Normal PR flow

Commit all changes first, then create the PR through the verified command:

```bash
pnpm pr:verified -- --title "Short title" --body "What changed and why"
```

That command performs the following sequence:

1. `pnpm ci:local` validates a clean `HEAD`.
2. The pre-push hook accepts only that exact successful SHA.
3. The branch is pushed and a `local-ci` status is attached to the immutable
   GitHub commit.
4. The PR is opened. Its tiny Actions-owned `checks` provenance job verifies
   that the status is successful, belongs to the PR author, targets the exact
   head SHA, and links to that commit.

Use `pnpm push:verified` when updating an existing PR. If a tested commit was
already pushed by another route, `pnpm ci:attest` can publish its status only
when the current upstream branch still points at the receipt's exact SHA.

## What the gate runs

The gate runs a frozen dependency install, Ultracite, the ffmpeg pin check,
Vitest including the destructive RLS suite, the Next production build (which
includes typechecking), production hydration e2e, and the complete dev e2e
suite. The test servers use free ports. Database and storage work is isolated
in a generated database, app role, and bucket, all removed in `finally` even
when a command fails or the gate receives an interrupt. The dev suite stops
after its first failed spec instead of spending minutes repeating the same root
cause. The normal `mitosia` database and `mitosia-media` bucket are not test
targets.

A successful receipt is stored under Git's private metadata, not in the
worktree. Any commit/amend/rebase changes the SHA, so the next push must run the
whole gate again. Dirty worktrees and pushes of a SHA other than checked-out
`HEAD` fail closed. Direct pushes to `main` and `production` are rejected.

## Failure and recovery

- Fix a failed command, commit the fix, and run `pnpm push:verified` again.
- Use `pnpm ci:local -- --force` to repeat an already successful exact SHA.
- A raw push or `--no-verify` does not create a valid attestation; branch
  protection keeps the PR blocked.
- If the provenance `checks` job ran before attestation, publish the status with
  `pnpm ci:attest` and re-run that one GitHub job.

## Re-enabling hosted CI

Before granting another person write access, restore independent hosted
lint/unit/build/e2e jobs from the history before this policy, make their GitHub
Actions contexts required, and replace the proof-only `checks` job.
Local developer attestations are useful protection against accidental bad
pushes; they are not an independent trust boundary for a team.
