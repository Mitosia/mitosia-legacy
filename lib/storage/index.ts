import { createReadStream } from "node:fs";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/env";

// One S3-compatible client for all object storage: MinIO in local dev,
// Cloudflare R2 deployed. Nothing outside lib/storage touches the SDK.

const storageClient = new S3Client({
  credentials: {
    accessKeyId: env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
  },
  endpoint: env.STORAGE_ENDPOINT,
  forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
  region: env.STORAGE_REGION,
});

const BUCKET = env.STORAGE_BUCKET;
const PART_URL_TTL_SECONDS = 3600;

export interface UploadedPart {
  etag: string;
  partNumber: number;
  size: number;
}

export async function createMultipartUpload(
  key: string,
  contentType: string
): Promise<string> {
  const result = await storageClient.send(
    new CreateMultipartUploadCommand({
      Bucket: BUCKET,
      ContentType: contentType,
      Key: key,
    })
  );

  if (!result.UploadId) {
    throw new Error("Storage did not return an upload id");
  }
  return result.UploadId;
}

export function presignUploadPart(
  key: string,
  uploadId: string,
  partNumber: number
): Promise<string> {
  return getSignedUrl(
    storageClient,
    new UploadPartCommand({
      Bucket: BUCKET,
      Key: key,
      PartNumber: partNumber,
      UploadId: uploadId,
    }),
    { expiresIn: PART_URL_TTL_SECONDS }
  );
}

export async function listUploadedParts(
  key: string,
  uploadId: string
): Promise<UploadedPart[]> {
  const parts: UploadedPart[] = [];
  let marker: string | undefined;

  do {
    // biome-ignore lint/performance/noAwaitInLoops: pages are sequential by marker
    const page = await storageClient.send(
      new ListPartsCommand({
        Bucket: BUCKET,
        Key: key,
        PartNumberMarker: marker,
        UploadId: uploadId,
      })
    );
    for (const part of page.Parts ?? []) {
      if (part.PartNumber && part.ETag) {
        parts.push({
          etag: part.ETag,
          partNumber: part.PartNumber,
          size: part.Size ?? 0,
        });
      }
    }
    marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
  } while (marker);

  return parts;
}

export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: { etag: string; partNumber: number }[]
): Promise<void> {
  await storageClient.send(
    new CompleteMultipartUploadCommand({
      Bucket: BUCKET,
      Key: key,
      MultipartUpload: {
        Parts: [...parts]
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((part) => ({ ETag: part.etag, PartNumber: part.partNumber })),
      },
      UploadId: uploadId,
    })
  );
}

export async function abortMultipartUpload(
  key: string,
  uploadId: string
): Promise<void> {
  await storageClient.send(
    new AbortMultipartUploadCommand({
      Bucket: BUCKET,
      Key: key,
      UploadId: uploadId,
    })
  );
}

export async function headObject(
  key: string
): Promise<{ contentType: string | undefined; size: number }> {
  const result = await storageClient.send(
    new HeadObjectCommand({ Bucket: BUCKET, Key: key })
  );
  return { contentType: result.ContentType, size: result.ContentLength ?? 0 };
}

// Short-lived read URL — used as direct ffmpeg/ffprobe input so the
// pipeline never has to download the original before working on it.
export function presignGetUrl(
  key: string,
  expiresInSeconds = 6 * 3600
): Promise<string> {
  return getSignedUrl(
    storageClient,
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn: expiresInSeconds }
  );
}

export function getObject(key: string, range?: string) {
  return storageClient.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: key, Range: range })
  );
}

export async function putFile(
  key: string,
  filePath: string,
  contentType: string
): Promise<void> {
  const upload = new Upload({
    client: storageClient,
    params: {
      Body: createReadStream(filePath),
      Bucket: BUCKET,
      ContentType: contentType,
      Key: key,
    },
  });
  await upload.done();
}

export async function putJson(key: string, value: unknown): Promise<void> {
  const upload = new Upload({
    client: storageClient,
    params: {
      Body: JSON.stringify(value),
      Bucket: BUCKET,
      ContentType: "application/json",
      Key: key,
    },
  });
  await upload.done();
}
