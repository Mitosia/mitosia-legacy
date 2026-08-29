#!/usr/bin/env node

// The one place that says which ffmpeg the ingest pipeline is written
// against. Every environment that runs `lib/media/` — a dev/local-gate
// machine, the Trigger worker, the deployed container — must agree on this minor, because an
// ffmpeg option that does not exist is a hard failure: ffmpeg refuses to
// start and the ingest dies, it is not a warning that degrades gracefully.
//
// Kept dependency-free and in plain .mjs on purpose: it runs inside the
// Docker runner stage, which has node but no node_modules and no bundler.
//
// Bumping the version is one PR with three moves (see AGENTS.md):
//   1. EXPECTED_MINOR here
//   2. the Alpine pin in the Dockerfile's runner stage (that is what picks
//      the deployed binary — Alpine ships one ffmpeg minor per release)
//   3. the mirrored static build: run scripts/mirror-ffmpeg.mjs against the
//      new BtbN build and paste the block it prints into
//      scripts/ffmpeg-pin.mjs
// Land those together or this check fails the side that lagged.

import { execFileSync } from "node:child_process";

const EXPECTED_MINOR = "8.1";

// Version lines vary by build. Alpine/Homebrew: "ffmpeg version 8.1.2 …".
// The BtbN-built static build Trigger uses (mirrored per scripts/ffmpeg-pin.mjs)
// report the branch git-describe: "ffmpeg version n8.1.2-44-g7c533d0f86-…".
// Git master builds report "N-126039-g…" with no version at all, and are
// rejected — an untagged build is not a version we can pin against.
const VERSION_LINE = /^\w+ version n?(\d+)\.(\d+)/;

function readVersion(command) {
  let output;
  try {
    output = execFileSync(command, ["-version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return { error: `${command} is not installed or not on PATH` };
    }
    return { error: `${command} -version failed: ${error.message}` };
  }

  const firstLine = output.split("\n", 1)[0] ?? "";
  const match = VERSION_LINE.exec(firstLine);
  if (!match) {
    return { error: `could not parse a version out of: ${firstLine}` };
  }
  return { minor: `${match[1]}.${match[2]}`, reported: firstLine.trim() };
}

const problems = [];
for (const command of ["ffmpeg", "ffprobe"]) {
  const result = readVersion(command);
  if (result.error) {
    problems.push(result.error);
    continue;
  }
  if (result.minor !== EXPECTED_MINOR) {
    problems.push(
      `${command} is ${result.minor}.x, expected ${EXPECTED_MINOR}.x — ${result.reported}`
    );
    continue;
  }
  process.stdout.write(`ok  ${result.reported}\n`);
}

if (problems.length > 0) {
  process.stderr.write(
    [
      `ffmpeg does not match the version this project ships (${EXPECTED_MINOR}.x):`,
      ...problems.map((problem) => `  - ${problem}`),
      "",
      `The deployed container and CI both run ffmpeg ${EXPECTED_MINOR}.x.`,
      "A different minor here means flags you verify locally may not exist",
      "there (or the reverse), and an unknown ffmpeg option breaks every",
      "ingest.",
      "",
      "  macOS:  brew install ffmpeg   (brew tracks the latest release)",
      "  Debian/Ubuntu: distro packages lag badly — use a static build,",
      "  the same one scripts/ffmpeg-pin.mjs pins.",
      "",
      "If ffmpeg has genuinely moved on, bump all three pins together —",
      "see the ffmpeg version rule in AGENTS.md.",
      "",
    ].join("\n")
  );
  process.exit(1);
}
