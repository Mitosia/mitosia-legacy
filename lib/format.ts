const BYTES_PER_UNIT = 1024;
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;

export function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return "0 B";
  }
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(BYTES_PER_UNIT)),
    BYTE_UNITS.length - 1
  );
  const value = bytes / BYTES_PER_UNIT ** exponent;
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${BYTE_UNITS[exponent]}`;
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.round(totalSeconds);
  const hours = Math.floor(seconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const remainder = seconds % SECONDS_PER_MINUTE;
  const paddedSeconds = String(remainder).padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`;
  }
  return `${minutes}:${paddedSeconds}`;
}
