"use client";

import "@uppy/core/css/style.min.css";
import "@uppy/dashboard/css/style.min.css";

import AwsS3 from "@uppy/aws-s3";
import type { Body, Meta, UppyFile } from "@uppy/core";
import Uppy from "@uppy/core";
import Dashboard from "@uppy/dashboard";
import GoldenRetriever from "@uppy/golden-retriever";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { UPLOAD_IDLE_TTL_MS } from "@/lib/upload-window";

// Resumable multipart uploads straight to object storage (Uppy AwsS3 →
// presigned part URLs from our API). The Dashboard is Uppy's own UI —
// registry-first doesn't apply to the upload widget itself, and pause/
// resume/retry states are exactly what it exists for.
//
// Resumption across browser sessions rests on four things, all of them
// load-bearing:
//
//  1. The source id lives in Uppy's file meta, not in a closure. Golden
//     Retriever persists file state (meta and @uppy/aws-s3's own
//     `s3Multipart` key/upload id included) to localStorage, so a reload
//     still knows which /api/uploads/[sourceId]/… routes to talk to. A
//     `Map` inside the effect died with the page and forced a restart
//     from byte 0 even though the server could already list the parts.
//  2. The Uppy instance is namespaced per project. Golden Retriever's
//     stores and Uppy's own file ids are both keyed by the instance id,
//     so a half-finished upload can only be restored onto the project it
//     was started in.
//  3. A restored upload is probed before it is trusted. The multipart
//     upload it points at may be gone (reaper, R2 expiry), and a stale
//     upload id fails on the first signed part with no way back.
//
// Browsers cannot hand a multi-GB File back after a reload, so Golden
// Retriever restores files over ~10 MB as "ghosts" and the Dashboard asks
// for them to be re-selected. Re-selecting the same file reproduces the
// same Uppy file id (name + type + size + lastModified), which is what
// reconnects it to the persisted upload — from there `listParts` skips
// everything storage already holds. Navigating away inside the app still
// cancels and aborts an in-flight upload, as before; the resume window is
// for the tab closing, not for leaving the page.
//
//  4. None of the above survives the browser state being destroyed, and it
//     is one click away: dismissing the recovery card drops the ghost, and
//     with it the source id and multipart state. Re-adding the same file
//     then started a SECOND multipart upload — observed on staging with a
//     2 GB source, which stranded 115 MB of parts and left a duplicate row
//     stuck at "uploading". So the server matches independently, on what it
//     can see for itself (same project, filename and byte size, still
//     uploading, quiet for longer than `UPLOAD_ADOPT_GRACE_SECONDS`), and
//     `adoptExistingUpload` seeds the state Uppy needs to resume. The same
//     check runs inside POST /api/uploads, so losing the race to a fast
//     click costs re-sent parts, never a stranded upload.

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_CONCURRENT_FILES = 10;

// Uppy file meta is a free-form bag; this is the one key we put in it.
interface SourceMeta extends Meta {
  sourceId?: string;
}

type SourceFile = UppyFile<SourceMeta, Body>;
type SourceUppy = Uppy<SourceMeta, Body>;

// `s3Multipart` is @uppy/aws-s3's own per-file state (the storage key and
// multipart upload id it resumes from). It is not part of Uppy's public
// file type, so clearing it needs a widened patch type.
type FileStatePatch = Partial<SourceFile> & {
  s3Multipart?: { key: string; uploadId: string };
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

function requireSourceId(file: SourceFile): string {
  const { sourceId } = file.meta;
  if (!sourceId) {
    throw new Error("Upload was never registered");
  }
  return sourceId;
}

// A restored upload is only worth resuming if storage still has the
// multipart upload behind it; the parts endpoint is exactly that question
// (404 once the source is gone or no longer "uploading"). Anything that
// cannot be continued is stripped back to a fresh file, so it restarts
// cleanly instead of erroring on its first signed part.
async function discardUnresumableUploads(uppy: SourceUppy): Promise<void> {
  await Promise.all(
    uppy.getFiles().map(async (file) => {
      const { sourceId } = file.meta;
      if (!sourceId || file.progress.uploadComplete) {
        return;
      }

      const resumable = await fetch(`/api/uploads/${sourceId}/parts`)
        .then((response) => response.ok)
        .catch(() => false);
      if (resumable) {
        return;
      }

      uppy.setFileMeta(file.id, { sourceId: undefined });
      const patch: FileStatePatch = {
        progress: {
          bytesTotal: file.progress.bytesTotal,
          bytesUploaded: false,
          percentage: 0,
          uploadComplete: false,
          uploadStarted: null,
        },
        s3Multipart: undefined,
      };
      uppy.setFileState(file.id, patch);
    })
  );
}

// Attaches a freshly added file to an unfinished upload of the same file in
// the same project, when the server has one. Seeding `s3Multipart` is what
// puts @uppy/aws-s3 on its restoring branch: it calls listParts and skips
// every part storage already holds, instead of createMultipartUpload and a
// second upload from byte 0.
async function adoptExistingUpload(
  uppy: SourceUppy,
  file: SourceFile,
  projectId: string
): Promise<void> {
  const query = new URLSearchParams({
    filename: file.name ?? "upload",
    projectId,
    size: String(file.size ?? 0),
  });
  const { upload } = await api<{
    upload: { key: string; sourceId: string; uploadId: string } | null;
  }>(`/api/uploads?${query}`);

  // The file may have been removed or started uploading while we asked.
  if (!(upload && uppy.getFile(file.id)) || file.progress.uploadStarted) {
    return;
  }

  uppy.setFileMeta(file.id, { sourceId: upload.sourceId });
  const patch: FileStatePatch = {
    s3Multipart: { key: upload.key, uploadId: upload.uploadId },
  };
  uppy.setFileState(file.id, patch);
  uppy.log(
    `[uploads] attached ${file.name} to unfinished upload ${upload.sourceId}`
  );
}

export function SourceUploader({ projectId }: { projectId: string }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const router = useRouter();

  useEffect(() => {
    const target = mountRef.current;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: refs are null until mount; biome's inference misses RefObject nullability
    if (!target) {
      return;
    }

    const uppy: SourceUppy = new Uppy<SourceMeta, Body>({
      id: `source-uploader-${projectId}`,
      restrictions: {
        allowedFileTypes: ["video/*", "audio/*"],
        maxFileSize: MAX_UPLOAD_BYTES,
        maxNumberOfFiles: MAX_CONCURRENT_FILES,
      },
    });

    uppy
      .use(Dashboard, {
        height: 300,
        inline: true,
        note: "Video or audio, up to 20 GB per file. Uploads can be paused and resumed; if the tab closes, re-select the same file within a day to carry on where it left off.",
        proudlyDisplayPoweredByUppy: false,
        target,
        // The app themes via a .dark ancestor class, not the OS setting —
        // Uppy's "auto" would follow the OS and mismatch the page.
        theme: document.documentElement.classList.contains("dark")
          ? "dark"
          : "light",
        width: "100%",
      })
      .use(AwsS3, {
        abortMultipartUpload: async (file) => {
          const { sourceId } = file.meta;
          if (sourceId) {
            await api(`/api/uploads/${sourceId}/abort`, { method: "POST" });
          }
        },
        completeMultipartUpload: async (file, { parts }) => {
          await api(`/api/uploads/${requireSourceId(file)}/complete`, {
            body: JSON.stringify({
              parts: parts.map((part) => ({
                etag: part.ETag,
                partNumber: part.PartNumber,
              })),
            }),
            method: "POST",
          });
          return {};
        },
        createMultipartUpload: async (file) => {
          const created = await api<{
            key: string;
            sourceId: string;
            uploadId: string;
          }>("/api/uploads", {
            body: JSON.stringify({
              filename: file.name ?? "upload",
              projectId,
              size: file.size ?? 0,
              type: file.type,
            }),
            method: "POST",
          });
          // Into file state, not a closure: this is what has to survive the
          // page going away. Uppy calls this once per upload, and never at
          // all when it is resuming one.
          uppy.setFileMeta(file.id, { sourceId: created.sourceId });
          return { key: created.key, uploadId: created.uploadId };
        },
        listParts: async (file) => {
          const result = await api<{
            parts: { ETag: string; PartNumber: number; Size: number }[];
          }>(`/api/uploads/${requireSourceId(file)}/parts`);
          return result.parts;
        },
        shouldUseMultipart: true,
        signPart: async (file, { partNumber }) => {
          const signed = await api<{ url: string }>(
            `/api/uploads/${requireSourceId(file)}/parts`,
            {
              body: JSON.stringify({ partNumber }),
              method: "POST",
            }
          );
          return { url: signed.url };
        },
      })
      .use(GoldenRetriever, { expires: UPLOAD_IDLE_TTL_MS });

    uppy.on("restored", () => {
      discardUnresumableUploads(uppy).catch((error: Error) => {
        uppy.log(error, "warning");
      });
    });

    // Golden Retriever's restore is the fast path, but it is destructible:
    // dismiss the recovery card, clear site data, or open the project in a
    // different browser and the file arrives with no resume state at all.
    // The server can still recognise it, so ask — and seed the state Uppy
    // needs to take its restoring branch (`s3Multipart` present) rather
    // than starting a second multipart upload.
    //
    // A pre-processor and not a `file-added` handler: Uppy awaits every
    // pre-processor before any uploader runs, so the answer is always in
    // place before the first part goes out. Answering on `file-added` was
    // a race a fast click could win, and losing it meant re-sending parts
    // storage already held.
    uppy.addPreProcessor(async (fileIds: string[]) => {
      await Promise.all(
        fileIds.map(async (fileId) => {
          const file = uppy.getFile(fileId);
          if (!file || file.meta.sourceId) {
            return;
          }
          if ((file as FileStatePatch).s3Multipart) {
            return;
          }
          try {
            await adoptExistingUpload(uppy, file, projectId);
          } catch (error) {
            // Non-fatal: the upload just starts fresh, and the same check
            // inside POST /api/uploads still rules out a duplicate row.
            uppy.log(error as Error, "warning");
          }
        })
      );
    });

    // Each finished file becomes a "queued for processing" row immediately.
    uppy.on("upload-success", () => {
      router.refresh();
    });

    return () => {
      uppy.destroy();
    };
  }, [projectId, router]);

  return <div ref={mountRef} />;
}
