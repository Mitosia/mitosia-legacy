import { z } from "zod";
import { requireOrgApi } from "@/lib/api-auth";
import { buildCues, cuesToSrt, cuesToVtt } from "@/lib/transcription/captions";
import { loadCurrentTranscript } from "@/lib/transcription/store";

// Subtitle export, generated on the fly from the current revision + speaker
// labels — nothing is stored, so a correction or a speaker rename is
// reflected in the very next download.

const querySchema = z.object({ format: z.enum(["srt", "vtt"]) });

export async function GET(
  request: Request,
  ctx: RouteContext<"/api/sources/[sourceId]/transcript">
) {
  const { sourceId } = await ctx.params;
  const parsedId = z.uuid().safeParse(sourceId);
  if (!parsedId.success) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const authCtx = await requireOrgApi();
  if ("error" in authCtx) {
    return authCtx.error;
  }

  const url = new URL(request.url);
  const parsedQuery = querySchema.safeParse({
    format: url.searchParams.get("format") ?? "srt",
  });
  if (!parsedQuery.success) {
    return Response.json({ error: "Unknown format" }, { status: 400 });
  }
  const { format } = parsedQuery.data;

  const current = await loadCurrentTranscript(
    authCtx.organizationId,
    parsedId.data
  );
  if (!current) {
    return Response.json({ error: "No transcript" }, { status: 404 });
  }

  const cues = buildCues(current.data.words);
  const body =
    format === "srt"
      ? cuesToSrt(cues, current.speakerLabels)
      : cuesToVtt(cues, current.speakerLabels);

  return new Response(body, {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="transcript-rev${current.revision}.${format}"`,
      "content-type":
        format === "srt" ? "application/x-subrip" : "text/vtt; charset=utf-8",
    },
  });
}
