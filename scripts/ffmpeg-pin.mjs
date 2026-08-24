// The pinned ffmpeg static build, in one place so the environments that
// cannot use a distro package still agree with the ones that can.
//
// Alpine pins the deployed container (one ffmpeg minor per release) and
// Homebrew covers dev machines, but two build environments have no package
// that ships this minor: the CI runner (Ubuntu's apt ffmpeg is 6.1.x) and
// the Trigger.dev deploy image (Debian's is 5.1.x). Both install the asset
// named here instead.
//
// The asset lives on THIS repo's own GitHub release (FFMPEG_MIRROR_TAG),
// not on BtbN/FFmpeg-Builds where it was built: BtbN prunes dated
// autobuild releases after ~2 weeks, which 404'd the previous pin on
// 2026-08-24 and broke every e2e run. FFMPEG_UPSTREAM_RELEASE records
// where the bytes came from; the mirror is where they live. The repo is
// private, so downloading needs GitHub auth — GITHUB_TOKEN in CI, an
// authenticated `gh` for manual Trigger deploys.
//
// scripts/check-ffmpeg-version.mjs holds EXPECTED_MINOR and is what
// actually enforces agreement; this file only says where to get a matching
// binary. Bumping ffmpeg means running scripts/mirror-ffmpeg.mjs against
// the new BtbN build, pasting the block it prints here, and changing
// EXPECTED_MINOR plus the Alpine tag in the Dockerfile, in one PR — see
// the ffmpeg version rule in AGENTS.md.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FFMPEG_UPSTREAM_RELEASE = "autobuild-2026-08-24-13-10";
export const FFMPEG_BUILD = "ffmpeg-n8.1.2-44-g7c533d0f86-linux64-gpl-8.1";
export const FFMPEG_SHA256 =
  "0ff8df62cb995a46c064b86f7992603ec38e60cd6992b05b43fd09e30bdc28b9";

export const FFMPEG_MIRROR_REPO = "Mitosia/mitosia";

// One release per mirrored build; scripts/mirror-ffmpeg.mjs creates them.
export function mirrorTagFor(build) {
  return `ffmpeg-static/${build}`;
}

export const FFMPEG_MIRROR_TAG = mirrorTagFor(FFMPEG_BUILD);
export const FFMPEG_ASSET = `${FFMPEG_BUILD}.tar.xz`;

// Where the archive sits inside the Trigger.dev image build context. Not
// "build", "dist" or "out" — the CLI's context archiver drops those names.
export const FFMPEG_CONTEXT_DIR = "pinned-ffmpeg";

// Download the pinned archive for the Trigger.dev deploy (config-eval
// time, on the machine running `trigger.dev deploy`). The download cannot
// happen inside the image build itself: Trigger's remote builders have no
// credentials for this private repo, so the deploying machine — which
// always has GitHub auth — fetches the bytes and ships them via the build
// context instead. Cached in tmpdir; the sha256 check decides reuse, so a
// stale or truncated cache entry is re-downloaded, never trusted.
export function ensureFfmpegArchive() {
  const cacheDir = join(tmpdir(), "mitosia-ffmpeg");
  const cached = join(cacheDir, FFMPEG_ASSET);
  if (existsSync(cached) && sha256Of(cached) === FFMPEG_SHA256) {
    return cached;
  }
  mkdirSync(cacheDir, { recursive: true });
  const partial = `${cached}.download-${process.pid}`;
  try {
    execFileSync(
      "gh",
      [
        "release",
        "download",
        FFMPEG_MIRROR_TAG,
        "--repo",
        FFMPEG_MIRROR_REPO,
        "--pattern",
        FFMPEG_ASSET,
        "--output",
        partial,
        "--clobber",
      ],
      { stdio: ["ignore", "inherit", "inherit"] }
    );
  } catch (error) {
    throw new Error(
      `Could not download ${FFMPEG_ASSET} from ${FFMPEG_MIRROR_REPO} release ${FFMPEG_MIRROR_TAG}. ` +
        "The Trigger.dev deploy needs GitHub auth on the deploying machine: GH_TOKEN in CI, " +
        "`gh auth login` locally. If the release itself is missing, re-mirror with " +
        "scripts/mirror-ffmpeg.mjs — see the ffmpeg rules in AGENTS.md.",
      { cause: error }
    );
  }
  const actual = sha256Of(partial);
  if (actual !== FFMPEG_SHA256) {
    throw new Error(
      `${FFMPEG_ASSET} from ${FFMPEG_MIRROR_TAG} has sha256 ${actual}, expected ${FFMPEG_SHA256} — ` +
        "the mirror release no longer serves the pinned bytes. Do not deploy; re-mirror and re-pin."
    );
  }
  renameSync(partial, cached);
  return cached;
}

// Shell for the Trigger.dev image layer. The archive is bind-mounted from
// the build context for the duration of the RUN — a COPY would leave a
// ~120 MB dead layer in the final image — and the checksum is re-verified
// in-image so a corrupted context fails the build, not the first ingest.
// One RUN, so a failure leaves no half-installed binary behind.
export function ffmpegImageInstruction() {
  const mounted = "/tmp/ffmpeg.tar.xz";
  const script = [
    "apt-get update",
    "apt-get install -y --no-install-recommends xz-utils",
    "rm -rf /var/lib/apt/lists/*",
    `echo "${FFMPEG_SHA256}  ${mounted}" | sha256sum -c -`,
    `tar -xJf ${mounted} -C /usr/bin --strip-components=2 "${FFMPEG_BUILD}/bin/ffmpeg" "${FFMPEG_BUILD}/bin/ffprobe"`,
  ].join(" && ");
  return `RUN --mount=type=bind,source=${FFMPEG_CONTEXT_DIR}/${FFMPEG_ASSET},target=${mounted} ${script}`;
}

function sha256Of(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
