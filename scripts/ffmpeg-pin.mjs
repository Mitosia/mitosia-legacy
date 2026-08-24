// The pinned ffmpeg static build, in one place so the environments that
// cannot use a distro package still agree with the ones that can.
//
// Alpine pins the deployed container (one ffmpeg minor per release) and
// Homebrew covers dev machines, but two build environments have no package
// that ships this minor: the CI runner (Ubuntu's apt ffmpeg is 6.1.x) and
// the Trigger.dev deploy image (Debian's is 5.1.x). Both install the asset
// named here instead.
//
// scripts/check-ffmpeg-version.mjs holds EXPECTED_MINOR and is what actually
// enforces agreement; this file only says where to get a matching binary.
// Bumping ffmpeg means changing both, plus the Alpine tag in the Dockerfile,
// in one PR — see the ffmpeg version rule in AGENTS.md.

// CAUTION: BtbN autobuild releases are NOT immutable — dated releases are
// pruned after ~2 weeks (the 2026-08-10 pin 404'd on 2026-08-24 and broke
// every CI e2e run). Until the asset is mirrored somewhere we control,
// this pin needs a refresh whenever CI starts 404ing: pick the newest
// autobuild's linux64-gpl-8.1 asset, download it, and paste its sha256.
export const FFMPEG_RELEASE = "autobuild-2026-08-24-13-10";
export const FFMPEG_BUILD = "ffmpeg-n8.1.2-44-g7c533d0f86-linux64-gpl-8.1";
export const FFMPEG_SHA256 =
  "0ff8df62cb995a46c064b86f7992603ec38e60cd6992b05b43fd09e30bdc28b9";

export const FFMPEG_URL = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_RELEASE}/${FFMPEG_BUILD}.tar.xz`;

// Shell to fetch, verify and install ffmpeg/ffprobe into /usr/bin. Written
// as one RUN so a failed checksum fails the layer rather than leaving a
// half-installed binary behind.
export function ffmpegInstallCommand() {
  return [
    "apt-get update",
    "apt-get install -y --no-install-recommends curl xz-utils ca-certificates",
    "rm -rf /var/lib/apt/lists/*",
    `curl -fsSL -o /tmp/ffmpeg.tar.xz "${FFMPEG_URL}"`,
    `echo "${FFMPEG_SHA256}  /tmp/ffmpeg.tar.xz" | sha256sum -c -`,
    `tar -xJf /tmp/ffmpeg.tar.xz -C /usr/bin --strip-components=2 "${FFMPEG_BUILD}/bin/ffmpeg" "${FFMPEG_BUILD}/bin/ffprobe"`,
    "rm /tmp/ffmpeg.tar.xz",
  ].join(" && ");
}
