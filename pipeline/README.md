# Mitosia pipeline

The Python harness layer: video-editing workflows orchestrated on Temporal.

- System design: [docs/pipeline-architecture.md](../docs/pipeline-architecture.md)
- Sequencing and harness roster: [docs/pipeline-implementation-plan.md](../docs/pipeline-implementation-plan.md)
- Editorial design (wins on editorial conflicts): [docs/clip-cut-architecture.md](../docs/clip-cut-architecture.md)
- Deviation log: [DECISIONS.md](DECISIONS.md)

Self-contained uv project — no pnpm workspace membership, no imports across
the seam. The only contracts with the Next.js app are Temporal (control),
`security_invoker` SQL views (reads), the usage ledger (writes), and
org-prefixed S3 keys (artifacts).

## Development

```sh
uv sync                 # create .venv from the committed lockfile
uv run ruff format .    # format
uv run ruff check .     # lint
uv run pyright          # typecheck (strict)
uv run pytest           # tests — CI runs cassette-only, never live LLM calls
```

The exact-commit local gate (`pnpm ci:local`) runs the frozen-sync versions
of all of the above; a PR is not deliverable without them green.
