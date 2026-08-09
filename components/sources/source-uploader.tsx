"use client";

import "@uppy/core/css/style.min.css";
import "@uppy/dashboard/css/style.min.css";

import AwsS3 from "@uppy/aws-s3";
import Uppy from "@uppy/core";
import Dashboard from "@uppy/dashboard";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

// Resumable multipart uploads straight to object storage (Uppy AwsS3 →
// presigned part URLs from our API). The Dashboard is Uppy's own UI —
// registry-first doesn't apply to the upload widget itself, and pause/
// resume/retry states are exactly what it exists for.

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_CONCURRENT_FILES = 10;

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

export function SourceUploader({ projectId }: { projectId: string }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const router = useRouter();

  useEffect(() => {
    const target = mountRef.current;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: refs are null until mount; biome's inference misses RefObject nullability
    if (!target) {
      return;
    }

    // file.id → sourceId, established when the multipart upload is created.
    const sourceIds = new Map<string, string>();

    const uppy = new Uppy({
      restrictions: {
        allowedFileTypes: ["video/*", "audio/*"],
        maxFileSize: MAX_UPLOAD_BYTES,
        maxNumberOfFiles: MAX_CONCURRENT_FILES,
      },
    })
      .use(Dashboard, {
        height: 300,
        inline: true,
        note: "Video or audio, up to 20 GB per file. Uploads can be paused and resumed.",
        proudlyDisplayPoweredByUppy: false,
        target,
        theme: "auto",
        width: "100%",
      })
      .use(AwsS3, {
        abortMultipartUpload: async (file) => {
          const sourceId = sourceIds.get(file.id);
          if (sourceId) {
            await api(`/api/uploads/${sourceId}/abort`, { method: "POST" });
          }
        },
        completeMultipartUpload: async (file, { parts }) => {
          const sourceId = sourceIds.get(file.id);
          if (!sourceId) {
            throw new Error("Upload was never registered");
          }
          await api(`/api/uploads/${sourceId}/complete`, {
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
          sourceIds.set(file.id, created.sourceId);
          return { key: created.key, uploadId: created.uploadId };
        },
        listParts: async (file) => {
          const sourceId = sourceIds.get(file.id);
          if (!sourceId) {
            return [];
          }
          const result = await api<{
            parts: { ETag: string; PartNumber: number; Size: number }[];
          }>(`/api/uploads/${sourceId}/parts`);
          return result.parts;
        },
        shouldUseMultipart: true,
        signPart: async (file, { partNumber }) => {
          const sourceId = sourceIds.get(file.id);
          if (!sourceId) {
            throw new Error("Upload was never registered");
          }
          const signed = await api<{ url: string }>(
            `/api/uploads/${sourceId}/parts`,
            {
              body: JSON.stringify({ partNumber }),
              method: "POST",
            }
          );
          return { url: signed.url };
        },
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
