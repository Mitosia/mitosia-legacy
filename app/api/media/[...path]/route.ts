import type { Readable } from "node:stream";
import { requireOrgApi } from "@/lib/api-auth";
import { getObject } from "@/lib/storage";
import { orgPrefix } from "@/lib/storage/keys";

// Authenticated media delivery: streams objects (HLS playlists/segments,
// posters, thumbnails, waveform peaks) from storage through the app, so
// playback stays same-origin — no storage CORS surface, no signed URLs in
// the client. HLS playlists reference segments relatively, so every
// follow-up request resolves back through this route and re-checks auth.
// The org/{id}/ key prefix is the authorization boundary: a session can
// only ever read keys under its own active organization.
//
// Good enough for proxy playback now; the R2+CDN signed-URL path arrives
// with client delivery/export work (S18).

export async function GET(
  request: Request,
  ctx: RouteContext<"/api/media/[...path]">
) {
  const authCtx = await requireOrgApi();
  if (authCtx.error) {
    return authCtx.error;
  }

  const { path } = await ctx.params;
  const key = path.join("/");

  if (!key.startsWith(orgPrefix(authCtx.organizationId))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const range = request.headers.get("range") ?? undefined;

  let object: Awaited<ReturnType<typeof getObject>>;
  try {
    object = await getObject(key, range);
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "NoSuchKey" || name === "NotFound") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    throw error;
  }

  if (!object.Body) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const headers = new Headers({ "accept-ranges": "bytes" });
  if (object.ContentType) {
    headers.set("content-type", object.ContentType);
  }
  if (object.ContentLength !== undefined) {
    headers.set("content-length", String(object.ContentLength));
  }
  if (object.ContentRange) {
    headers.set("content-range", object.ContentRange);
  }
  // Segments and playlists are immutable per ingest run; short private
  // caching keeps scrubbing snappy without a shared-cache leak vector.
  headers.set("cache-control", "private, max-age=3600");

  const body = object.Body.transformToWebStream
    ? object.Body.transformToWebStream()
    : // node-fetch style fallback; the SDK returns a web stream in practice
      (object.Body as unknown as Readable);

  return new Response(body as ReadableStream, {
    headers,
    status: object.ContentRange ? 206 : 200,
  });
}
