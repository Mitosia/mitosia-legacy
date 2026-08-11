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

export const FFMPEG_RELEASE = "autobuild-2026-08-10-13-17";
export const FFMPEG_BUILD = "ffmpeg-n8.1.2-34-g9b6c8969e0-linux64-gpl-8.1";
export const FFMPEG_SHA256 =
  "7b0c2ad593860d8bb157e346777ac7d741b5bf25b456382051138aaa8256f92d";

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
