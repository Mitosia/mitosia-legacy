// ffmpeg/ffprobe echo their input URL into stderr, so command failures embed
// the presigned storage URL — signature query string included — in the error
// message. ingestError is stored and rendered in the UI, and presigned URLs
// must never reach the client, so strip every URL query string before it is
// persisted. Prose question marks ("readable? Retry") survive: only a "?"
// directly followed by non-whitespace is treated as a query string.
export function sanitizeIngestError(message: string): string {
  return message.replace(/\?\S+/g, "");
}
