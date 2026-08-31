import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildFixtureSnapshot,
  buildSyntheticSnapshot,
  type ParityFixture,
} from "../lib/ai/evals/parity";

// Keeps the committed eval-parity snapshots honest against the TS code
// they were dumped from: any change to a scorer, a mock provider, or a
// fixture that alters scorer inputs or outputs fails here until
// `pnpm eval:parity` regenerates the snapshots. The Python suite replays
// the same snapshots through the ported scorers, so this test plus
// pipeline/tests/test_parity.py together enforce cross-language parity
// in every local-CI run.

const FIXTURE_DIR = join(process.cwd(), "evals", "fixtures");
const PARITY_DIR = join(process.cwd(), "pipeline", "tests", "parity");

function readSnapshot(name: string): unknown {
  return JSON.parse(readFileSync(join(PARITY_DIR, name), "utf8"));
}

describe("eval parity snapshots", () => {
  beforeAll(() => {
    process.env.ANALYSIS_PROVIDER = "mock";
  });

  it("matches a fresh dump for every fixture", async () => {
    const files = readdirSync(FIXTURE_DIR).filter((file) =>
      file.endsWith(".json")
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const snapshotExists = existsSync(join(PARITY_DIR, file));
      if (file.startsWith("local-") && !snapshotExists) {
        // Local real-transcript fixtures are gitignored; their snapshots
        // are optional local artifacts, not part of the committed gate.
        continue;
      }
      const fixture = JSON.parse(
        readFileSync(join(FIXTURE_DIR, file), "utf8")
      ) as ParityFixture;
      // biome-ignore lint/performance/noAwaitInLoops: sequential keeps failures attributable
      const fresh = await buildFixtureSnapshot(fixture);
      expect(
        snapshotExists,
        `missing parity snapshot for ${file} — run pnpm eval:parity`
      ).toBe(true);
      expect(
        readSnapshot(file),
        `stale parity snapshot for ${file} — run pnpm eval:parity`
      ).toEqual(JSON.parse(JSON.stringify(fresh)));
    }
  });

  it("matches a fresh dump of the synthetic cases", () => {
    const fresh = buildSyntheticSnapshot();
    expect(
      existsSync(join(PARITY_DIR, "synthetic.json")),
      "missing synthetic parity snapshot — run pnpm eval:parity"
    ).toBe(true);
    expect(
      readSnapshot("synthetic.json"),
      "stale synthetic parity snapshot — run pnpm eval:parity"
    ).toEqual(JSON.parse(JSON.stringify(fresh)));
  });
});
