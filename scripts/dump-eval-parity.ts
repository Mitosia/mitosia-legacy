import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  buildFixtureSnapshot,
  buildSyntheticSnapshot,
  type ParityFixture,
} from "@/lib/ai/evals/parity";

// Writes the cross-language eval-parity snapshots the Python pipeline's
// scorer port is tested against (pipeline phase A1): one snapshot per
// fixture in evals/fixtures (mock-mode run of the same flow as `pnpm
// eval`), plus the synthetic branch-coverage cases. Snapshots for
// committed fixtures are committed under pipeline/tests/parity/ and kept
// honest by tests/eval-parity-snapshot.test.ts; snapshots for gitignored
// local-*.json fixtures stay local too.
//
//   pnpm eval:parity
//
// Re-run whenever a scorer, a mock provider, or a fixture changes, and
// commit the diff — the vitest suite fails on stale snapshots.

process.env.ANALYSIS_PROVIDER = "mock";

async function main(): Promise<void> {
  const fixtureDir = join(process.cwd(), "evals", "fixtures");
  const outDir = join(process.cwd(), "pipeline", "tests", "parity");
  const files = readdirSync(fixtureDir).filter((file) =>
    file.endsWith(".json")
  );

  for (const file of files) {
    const fixture = JSON.parse(
      readFileSync(join(fixtureDir, file), "utf8")
    ) as ParityFixture;
    // biome-ignore lint/performance/noAwaitInLoops: sequential keeps the report readable
    const snapshot = await buildFixtureSnapshot(fixture);
    const outFile = join(outDir, basename(file));
    writeFileSync(outFile, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(`wrote ${outFile} (${snapshot.cases.length} cases)`);
  }

  const synthetic = buildSyntheticSnapshot();
  const syntheticFile = join(outDir, "synthetic.json");
  writeFileSync(syntheticFile, `${JSON.stringify(synthetic, null, 2)}\n`);
  console.log(`wrote ${syntheticFile} (${synthetic.cases.length} cases)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
