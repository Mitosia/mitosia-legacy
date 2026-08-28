# Golden eval fixtures

`pnpm eval` reads every JSON file in `evals/fixtures`. A fixture may add an
optional `segmentBoundaryGold` case for chapter-granularity evaluation:

```json
{
  "segmentBoundaryGold": {
    "roughItems": [],
    "tableOfContents": [],
    "decisions": [
      {
        "afterAtomId": "A000",
        "keep": false,
        "note": "the question and its direct answer are one topic"
      }
    ]
  }
}
```

`roughItems` is a human-reviewed, pinned rough segment plan using the same
shape returned by `runSegmentPlan`; it is not regenerated during the semantic
boundary case. Atoms are numbered `A000`, `A001`, and so on after chronological
sorting. A decision labels the boundary immediately after that atom:

- `keep: true` means both sides are independently selectable topics.
- `keep: false` means the Reconciler should dissolve the boundary.

Label only high-confidence semantic boundaries. Do not derive gold from clip
duration. Mock eval runs skip this semantic score; real-provider runs reconcile
the pinned plan and macro-average the represented KEEP and REMOVE classes so
uniform over-fragmentation and uniform over-merging both fail.
