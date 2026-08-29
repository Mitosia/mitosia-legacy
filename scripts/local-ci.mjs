#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT_VERSION = 1;
const SUCCESS_COMMANDS = [
  "pnpm check",
  "pnpm check:ffmpeg",
  "docker build --output type=cacheonly .",
  "pnpm test",
  "pnpm exec next build --webpack",
  "pnpm e2e:prod",
  "pnpm exec playwright test --max-failures=1",
];
let receivedSignal;

process.chdir(ROOT);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    receivedSignal ??= signal;
  });
}

function assertNotInterrupted() {
  if (receivedSignal) {
    throw new Error(`Local CI was interrupted by ${receivedSignal}`);
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`
    );
  }

  return result.stdout.trim();
}

function run(command, args, env = process.env) {
  assertNotInterrupted();
  process.stdout.write(`\n> ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  assertNotInterrupted();
  if (result.status !== 0) {
    const ending = result.signal
      ? `terminated by ${result.signal}`
      : `exited ${result.status}`;
    throw new Error(`${command} ${args.join(" ")} ${ending}`);
  }
}

function currentSha() {
  return capture("git", ["rev-parse", "HEAD"]);
}

function receiptPath() {
  return resolve(
    ROOT,
    capture("git", ["rev-parse", "--git-path", "local-ci/receipt.json"])
  );
}

function readReceipt() {
  const path = receiptPath();
  if (!existsSync(path)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function assertClean(expectedSha) {
  const sha = currentSha();
  if (sha !== expectedSha) {
    throw new Error(
      `HEAD moved during validation (expected ${expectedSha}, found ${sha}). Run the gate again.`
    );
  }

  const dirty = capture("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (dirty) {
    throw new Error(
      `Local CI only attests a clean commit. Commit or stash these changes first:\n${dirty}`
    );
  }
}

function writeReceipt(sha, startedAt) {
  const path = receiptPath();
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const payload = {
    commands: SUCCESS_COMMANDS,
    completedAt: new Date().toISOString(),
    node: process.version,
    sha,
    startedAt,
    version: RECEIPT_VERSION,
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
  return payload;
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function databaseUrl(baseUrl, database, username, password) {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  if (username) {
    url.username = username;
  }
  if (password) {
    url.password = password;
  }
  return url.toString();
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a local Playwright port"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function databaseTools() {
  const pg = await import("pg");
  return pg.default ?? pg;
}

async function storageTools() {
  return await import("@aws-sdk/client-s3");
}

async function createDatabase(adminUrl, database, role, password) {
  const { Pool } = await databaseTools();
  const pool = new Pool({ connectionString: adminUrl });
  try {
    await pool.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
    try {
      // password is a generated lowercase hex string, never user input.
      await pool.query(
        `CREATE ROLE ${quoteIdentifier(role)} LOGIN PASSWORD '${password}'`
      );
    } catch (error) {
      await pool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`);
      throw error;
    }
  } finally {
    await pool.end();
  }
}

async function grantAppRole(ownerUrl, database, role) {
  const { Pool } = await databaseTools();
  const pool = new Pool({ connectionString: ownerUrl });
  const quotedRole = quoteIdentifier(role);
  try {
    await pool.query(
      `GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${quotedRole}`
    );
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${quotedRole}`);
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quotedRole}`
    );
    await pool.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quotedRole}`
    );
    await pool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quotedRole}`
    );
    await pool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${quotedRole}`
    );
  } finally {
    await pool.end();
  }
}

async function dropDatabase(adminUrl, database, role) {
  const { Pool } = await databaseTools();
  const pool = new Pool({ connectionString: adminUrl });
  try {
    await pool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database]
    );
    await pool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`);
    await pool.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
  } finally {
    await pool.end();
  }
}

async function createBucket(endpoint, bucket) {
  const { CreateBucketCommand, S3Client } = await storageTools();
  const client = new S3Client({
    credentials: {
      accessKeyId: "mitosia",
      secretAccessKey: "mitosia-dev",
    },
    endpoint,
    forcePathStyle: true,
    region: "us-east-1",
  });
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } finally {
    client.destroy();
  }
}

async function dropBucket(endpoint, bucket) {
  const {
    AbortMultipartUploadCommand,
    DeleteBucketCommand,
    DeleteObjectsCommand,
    ListMultipartUploadsCommand,
    ListObjectsV2Command,
    S3Client,
  } = await storageTools();
  const client = new S3Client({
    credentials: {
      accessKeyId: "mitosia",
      secretAccessKey: "mitosia-dev",
    },
    endpoint,
    forcePathStyle: true,
    region: "us-east-1",
  });

  try {
    let uploadsRemain = true;
    while (uploadsRemain) {
      // biome-ignore lint/performance/noAwaitInLoops: cleanup must drain every page before deleting the bucket
      const uploads = await client.send(
        new ListMultipartUploadsCommand({ Bucket: bucket })
      );
      const aborts = (uploads.Uploads ?? [])
        .filter((upload) => upload.Key && upload.UploadId)
        .map((upload) =>
          client.send(
            new AbortMultipartUploadCommand({
              Bucket: bucket,
              Key: upload.Key,
              UploadId: upload.UploadId,
            })
          )
        );
      await Promise.all(aborts);
      uploadsRemain = aborts.length > 0;
    }

    let objectsRemain = true;
    while (objectsRemain) {
      // biome-ignore lint/performance/noAwaitInLoops: cleanup must drain every page before deleting the bucket
      const objects = await client.send(
        new ListObjectsV2Command({ Bucket: bucket })
      );
      const entries = (objects.Contents ?? [])
        .filter((object) => object.Key)
        .map((object) => ({ Key: object.Key }));
      if (entries.length > 0) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: entries, Quiet: true },
          })
        );
      }
      objectsRemain = entries.length > 0;
    }

    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
  } finally {
    client.destroy();
  }
}

async function runFullGate(sha) {
  const startedAt = new Date().toISOString();
  const stamp = `${Date.now().toString(36)}_${process.pid}`.toLowerCase();
  const database = `mitosia_local_ci_${stamp}`;
  const role = `mitosia_local_ci_app_${stamp}`;
  const password = createHash("sha256")
    .update(`${sha}:${stamp}`)
    .digest("hex")
    .slice(0, 32);
  const bucket = `mitosia-local-ci-${stamp.replaceAll("_", "-")}`;
  const adminUrl =
    process.env.LOCAL_CI_POSTGRES_URL ??
    "postgres://mitosia:mitosia@127.0.0.1:55433/postgres";
  const ownerUrl = databaseUrl(adminUrl, database);
  const appUrl = databaseUrl(adminUrl, database, role, password);
  const storageEndpoint =
    process.env.LOCAL_CI_STORAGE_ENDPOINT ?? "http://127.0.0.1:55490";
  const [devPort, prodPort] = await Promise.all([freePort(), freePort()]);
  const env = {
    ...process.env,
    ANALYSIS_PROVIDER: "mock",
    BETTER_AUTH_SECRET: "local-ci-only-placeholder-secret-32-chars",
    BETTER_AUTH_URL: `http://localhost:${devPort}`,
    CI: "1",
    DATABASE_URL: appUrl,
    E2E_PORT: String(devPort),
    E2E_PROD_PORT: String(prodPort),
    EMBEDDING_PROVIDER: "mock",
    LOCAL_CI: "1",
    MIGRATE_DATABASE_URL: ownerUrl,
    STORAGE_ACCESS_KEY_ID: "mitosia",
    STORAGE_BUCKET: bucket,
    STORAGE_ENDPOINT: storageEndpoint,
    STORAGE_FORCE_PATH_STYLE: "true",
    STORAGE_REGION: "us-east-1",
    STORAGE_SECRET_ACCESS_KEY: "mitosia-dev",
    TEST_DATABASE_URL: ownerUrl,
    TRANSCRIPTION_PROVIDER: "mock",
    TRIGGER_SECRET_KEY: "",
  };
  let bucketCreated = false;
  let databaseCreated = false;
  let failure;

  process.stdout.write(
    `Validating exact commit ${sha}\nDisposable database: ${database}\nDisposable bucket: ${bucket}\n`
  );

  try {
    run("pnpm", ["install", "--frozen-lockfile"]);
    run("pnpm", ["check"]);
    run("pnpm", ["check:ffmpeg"]);
    // CI rebuilds both production and development artifacts from scratch.
    // Reclaim stale ignored caches first so repeated verified deliveries do
    // not exhaust the host disk during multipart-upload e2e coverage.
    rmSync(resolve(ROOT, ".next"), { force: true, recursive: true });
    // The full image is the deploy contract and exercises Turbopack inside
    // its real Linux container. The host-side Webpack build below supplies
    // standalone output for Playwright without depending on a Rust helper
    // that restricted coding-agent sandboxes cannot launch.
    run("docker", ["build", "--output", "type=cacheonly", "."]);
    run("pnpm", ["exec", "playwright", "install", "chromium"]);
    run("docker", ["compose", "up", "-d", "--wait", "postgres", "minio"]);

    await createDatabase(adminUrl, database, role, password);
    databaseCreated = true;
    assertNotInterrupted();
    await createBucket(storageEndpoint, bucket);
    bucketCreated = true;
    assertNotInterrupted();

    run("pnpm", ["test"], env);
    await grantAppRole(ownerUrl, database, role);
    assertNotInterrupted();

    // Next includes .next/dev/types in tsconfig; an interrupted dev server can
    // leave a half-written generated file that has nothing to do with HEAD.
    rmSync(resolve(ROOT, ".next/dev"), { force: true, recursive: true });
    run("pnpm", ["exec", "next", "build", "--webpack"], env);
    run("pnpm", ["e2e:prod"], env);
    // The complete suite still runs on success; on failure there is no value
    // in spending minutes collecting the same root cause from later specs.
    run("pnpm", ["exec", "playwright", "test", "--max-failures=1"], env);
  } catch (error) {
    failure = error;
  } finally {
    if (bucketCreated) {
      try {
        await dropBucket(storageEndpoint, bucket);
      } catch (error) {
        process.stderr.write(`Local CI bucket cleanup failed: ${error}\n`);
        failure ??= error;
      }
    }
    if (databaseCreated) {
      try {
        await dropDatabase(adminUrl, database, role);
      } catch (error) {
        process.stderr.write(`Local CI database cleanup failed: ${error}\n`);
        failure ??= error;
      }
    }
  }

  if (failure) {
    throw failure;
  }

  assertClean(sha);
  const receipt = writeReceipt(sha, startedAt);
  process.stdout.write(
    `\nLocal CI passed for ${sha} at ${receipt.completedAt}.\n`
  );
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const expectedIndex = process.argv.indexOf("--require-sha");
  const expectedSha =
    expectedIndex === -1 ? null : process.argv.at(expectedIndex + 1);
  const sha = currentSha();

  if (expectedIndex !== -1 && !expectedSha) {
    throw new Error("--require-sha needs a commit SHA");
  }
  if (expectedSha && expectedSha !== sha) {
    throw new Error(
      `Push targets ${expectedSha}, but the checked-out HEAD is ${sha}. Check out the pushed branch and validate it.`
    );
  }

  assertClean(sha);
  const receipt = readReceipt();
  if (
    !args.has("--force") &&
    receipt?.version === RECEIPT_VERSION &&
    receipt.sha === sha
  ) {
    process.stdout.write(
      `Local CI already passed for exact commit ${sha} at ${receipt.completedAt}.\n`
    );
    return;
  }

  await runFullGate(sha);
}

main().catch((error) => {
  process.stderr.write(`\nLocal CI failed: ${error.message ?? error}\n`);
  process.exit(1);
});
