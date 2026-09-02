"""Eval runner, deterministic scorers, and review metrics (phase A1).

Ported as behavior from ``lib/ai/evals/scorers.ts``,
``lib/intelligence/review-metrics.ts``, and ``scripts/run-evals.ts``'s
report semantics. Cross-language parity is enforced by the snapshots under
``pipeline/tests/parity/`` (dumped by ``pnpm eval:parity``, kept honest by
the TS vitest suite, replayed here by pytest).
"""
