import {
  GetBucketLifecycleConfigurationCommand,
  S3Client,
} from "@aws-sdk/client-s3";

// Verifies the housekeeping rule docs/media-infra-setup.md says to check
// rather than assume: incomplete multipart uploads must be aborted
// automatically. Every abandoned browser upload leaves parts behind, and
// R2 bills for them until something reaps them — the app's own stale-upload
// sweep handles the ones it knows about, this is the backstop for the rest
// (uploads whose source row was deleted, or created before the sweep
// existed). R2 ships a "Default Multipart Abort Rule" (7 days) on new
// buckets, but it can be disabled, so it gets checked, not assumed.
//
// Run against any environment by pointing STORAGE_* at it:
//   pnpm check:abort-rule                      # local MinIO from .env
//   STORAGE_ENDPOINT=… STORAGE_BUCKET=… … pnpm check:abort-rule

const MAX_ABORT_DAYS = 7;

function write(line: string) {
  process.stdout.write(`${line}\n`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

async function main() {
  const bucket = required("STORAGE_BUCKET");
  const endpoint = required("STORAGE_ENDPOINT");

  const client = new S3Client({
    credentials: {
      accessKeyId: required("STORAGE_ACCESS_KEY_ID"),
      secretAccessKey: required("STORAGE_SECRET_ACCESS_KEY"),
    },
    endpoint,
    forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === "true",
    region: process.env.STORAGE_REGION ?? "auto",
  });

  const rules = await client
    .send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }))
    .then((result) => result.Rules ?? [])
    // A bucket with no lifecycle configuration at all answers with an
    // error, not an empty list.
    .catch(() => []);

  const aborting = rules.filter(
    (rule) =>
      rule.Status === "Enabled" &&
      rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation !== undefined
  );

  write(`bucket:   ${bucket}`);
  write(`endpoint: ${endpoint}\n`);

  if (aborting.length === 0) {
    write("FAIL: no enabled rule aborts incomplete multipart uploads.");
    write("      Abandoned uploads accumulate billable parts forever.");
    write("      R2: Bucket → Settings → Object Lifecycle Rules → enable");
    write(
      `      the "Default Multipart Abort Rule" (${MAX_ABORT_DAYS} days, no prefix).`
    );
    process.exit(1);
  }

  for (const rule of aborting) {
    const days = rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation;
    const scope = rule.Filter?.Prefix ?? "(whole bucket)";
    write(
      `OK: "${rule.ID ?? "unnamed"}" aborts incomplete uploads after ${days} day(s), scope ${scope}`
    );
  }

  const widest = Math.max(
    ...aborting.map(
      (rule) => rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation ?? 0
    )
  );
  if (widest > MAX_ABORT_DAYS) {
    write(
      `\nWARN: ${widest} days is longer than the documented ${MAX_ABORT_DAYS}-day backstop.`
    );
  }
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`abort-rule check failed: ${error}\n`);
  process.exit(1);
});
