#!/usr/bin/env node

// Mirror a BtbN/FFmpeg-Builds static build into this repo's own GitHub
// release, which is where CI and the Trigger.dev deploy image download it
// from (see scripts/ffmpeg-pin.mjs).
//
// Why a mirror exists at all: BtbN prunes dated autobuild releases after
// ~2 weeks. The 2026-08-10 pin 404'd on 2026-08-24 and broke every e2e run
// — an upstream URL is not a durable home for a checksummed pin. Bytes we
// verify get re-hosted where only we can delete them.
//
// Usage:
//   node scripts/mirror-ffmpeg.mjs <btbn-release-tag> [asset-name]
//
//   <btbn-release-tag>  e.g. autobuild-2026-08-24-13-10 (or a month-end
//                       tag — BtbN keeps those longer, but still without
//                       any documented guarantee)
//   [asset-name]        required when the release carries more than one
//                       linux64-gpl release-branch tarball (e.g. both 8.1
//                       and 9.0); the script lists the candidates.
//
// The script verifies the download against the release's own
// checksums.sha256 before uploading, creates the mirror release with
// provenance notes, and prints the block to paste into
// scripts/ffmpeg-pin.mjs. Needs an authenticated `gh` (repo write).
// Re-running for an already-mirrored build verifies and exits 0.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FFMPEG_MIRROR_REPO, mirrorTagFor } from "./ffmpeg-pin.mjs";

const UPSTREAM_REPO = "BtbN/FFmpeg-Builds";

// Static linux x64 GPL release-branch tarballs only — that is the build
// every environment pins. Master-branch builds ("ffmpeg-N-…") are
// versionless and rejected by check-ffmpeg-version.mjs anyway.
const RELEASE_BRANCH_TARBALL = /^ffmpeg-n[\d.]+.*linux64-gpl-[\d.]+\.tar\.xz$/;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function gh(args, options = {}) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  });
}

function sha256Of(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const [upstreamTag, assetArg] = process.argv.slice(2);
if (!upstreamTag) {
  fail("Usage: node scripts/mirror-ffmpeg.mjs <btbn-release-tag> [asset-name]");
}

// 1. Resolve the asset within the upstream release.
const releaseJson = JSON.parse(
  gh(["api", `repos/${UPSTREAM_REPO}/releases/tags/${upstreamTag}`])
);
const candidates = releaseJson.assets
  .map((asset) => asset.name)
  .filter(
    (name) => RELEASE_BRANCH_TARBALL.test(name) && !name.includes("-shared")
  );
function resolveAssetName() {
  if (assetArg) {
    if (!releaseJson.assets.some((asset) => asset.name === assetArg)) {
      fail(`Release ${upstreamTag} has no asset named ${assetArg}`);
    }
    return assetArg;
  }
  if (candidates.length !== 1) {
    fail(
      [
        `Release ${upstreamTag} has ${candidates.length} linux64-gpl release-branch tarballs — pass one explicitly:`,
        ...candidates.map((name) => `  ${name}`),
      ].join("\n")
    );
  }
  const [onlyCandidate] = candidates;
  return onlyCandidate;
}

const assetName = resolveAssetName();

const build = assetName.replace(/\.tar\.xz$/, "");
const mirrorTag = mirrorTagFor(build);

// 2. Download the tarball and the release's own checksum manifest.
const workDir = mkdtempSync(join(tmpdir(), "mirror-ffmpeg-"));
process.stdout.write(`Downloading ${assetName} from ${upstreamTag}…\n`);
gh(
  [
    "release",
    "download",
    upstreamTag,
    "--repo",
    UPSTREAM_REPO,
    "--pattern",
    assetName,
    "--pattern",
    "checksums.sha256",
    "--dir",
    workDir,
  ],
  { stdio: ["ignore", "inherit", "inherit"] }
);

// 3. Verify against upstream's manifest before re-hosting anything. A
// mirror of unverified bytes would launder a corrupt download into a
// trusted pin.
const archivePath = join(workDir, assetName);
const actualSha = sha256Of(archivePath);
const manifest = readFileSync(join(workDir, "checksums.sha256"), "utf8");
const manifestLine = manifest
  .split("\n")
  .find(
    (line) =>
      line.trim().endsWith(`  ${assetName}`) ||
      line.trim().endsWith(` ${assetName}`)
  );
if (!manifestLine) {
  fail(`checksums.sha256 in ${upstreamTag} has no entry for ${assetName}`);
}
const [upstreamSha] = manifestLine.trim().split(/\s+/);
if (actualSha !== upstreamSha) {
  fail(
    `Downloaded bytes do not match upstream's checksums.sha256:\n  upstream ${upstreamSha}\n  actual   ${actualSha}`
  );
}
process.stdout.write(
  `sha256 verified against upstream manifest: ${actualSha}\n`
);

// 4. Idempotence: if this build is already mirrored, verify and stop.
let existing = null;
try {
  existing = JSON.parse(
    gh(["api", `repos/${FFMPEG_MIRROR_REPO}/releases/tags/${mirrorTag}`], {
      stdio: ["ignore", "pipe", "ignore"],
    })
  );
} catch {
  // 404 — not mirrored yet.
}
if (existing) {
  const mirrored = existing.assets.find((asset) => asset.name === assetName);
  if (!mirrored) {
    fail(
      `Mirror release ${mirrorTag} exists but has no ${assetName} asset — delete the release and re-run.`
    );
  }
  process.stdout.write(`Already mirrored as ${mirrorTag} — nothing to do.\n`);
} else {
  // 5. Create the mirror release. --latest=false keeps asset mirrors out
  // of the repo's "latest release" slot. The upstream manifest is attached
  // under a distinct name so the provenance cross-check survives upstream
  // pruning.
  const manifestCopy = join(workDir, "upstream-checksums.sha256");
  copyFileSync(join(workDir, "checksums.sha256"), manifestCopy);
  const notes = [
    `Mirror of \`${assetName}\` from ${UPSTREAM_REPO} release \`${upstreamTag}\`,`,
    `retrieved ${new Date().toISOString().slice(0, 10)} and verified against that release's own \`checksums.sha256\``,
    "(attached here as `upstream-checksums.sha256`).",
    "",
    `sha256: \`${actualSha}\``,
    "",
    "Mirrored because BtbN prunes dated autobuild releases after ~2 weeks, which broke CI when the",
    `previous pin's release vanished. This release is the durable home the pin in`,
    "`scripts/ffmpeg-pin.mjs` points at — deleting it breaks the CI e2e job and Trigger.dev deploys.",
    "",
    `License: this is a GPLv3 ffmpeg binary built by ${UPSTREAM_REPO} (the \`n\` git-describe in the`,
    "asset name pins the exact FFmpeg release-branch commit; the statically linked library set is",
    "defined by the BtbN build scripts). It is redistributed only within this private repository.",
    "If this repository is ever made public, distributing the binary carries a GPLv3 corresponding-",
    "source obligation — attach the FFmpeg source tarball for the tagged commit plus the BtbN build",
    "recipe, or take the mirror private again, before flipping visibility.",
  ].join("\n");
  process.stdout.write(
    `Creating ${FFMPEG_MIRROR_REPO} release ${mirrorTag}…\n`
  );
  gh(
    [
      "release",
      "create",
      mirrorTag,
      "--repo",
      FFMPEG_MIRROR_REPO,
      "--target",
      "main",
      "--latest=false",
      "--title",
      `ffmpeg static mirror: ${build}`,
      "--notes",
      notes,
      archivePath,
      manifestCopy,
    ],
    { stdio: ["ignore", "inherit", "inherit"] }
  );
}

// 6. Round-trip: download from the mirror and re-verify, so the pin block
// below is only ever printed for bytes the mirror actually serves.
const roundTripDir = mkdtempSync(join(tmpdir(), "mirror-ffmpeg-verify-"));
gh(
  [
    "release",
    "download",
    mirrorTag,
    "--repo",
    FFMPEG_MIRROR_REPO,
    "--pattern",
    assetName,
    "--dir",
    roundTripDir,
  ],
  { stdio: ["ignore", "inherit", "inherit"] }
);
const roundTripSha = sha256Of(join(roundTripDir, assetName));
if (roundTripSha !== actualSha) {
  fail(
    `Mirror round-trip sha mismatch — the mirrored asset is not the verified bytes:\n  expected ${actualSha}\n  got      ${roundTripSha}`
  );
}
process.stdout.write(
  [
    "Mirror verified end to end.",
    "",
    "Update scripts/ffmpeg-pin.mjs to:",
    "",
    `export const FFMPEG_UPSTREAM_RELEASE = "${upstreamTag}";`,
    `export const FFMPEG_BUILD = "${build}";`,
    "export const FFMPEG_SHA256 =",
    `  "${actualSha}";`,
    "",
  ].join("\n")
);
