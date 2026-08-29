#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_BRANCH = /^(chore|docs|feat|fix)\//;
const GITHUB_ORIGIN = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/;
const WORKFLOW_REGISTRATION_ATTEMPTS = 30;
const WORKFLOW_REGISTRATION_INTERVAL_MS = 3000;

process.chdir(ROOT);

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: ROOT,
    encoding: options.capture ? "utf8" : undefined,
    env: process.env,
    stdio: options.capture ? "pipe" : "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = options.capture
      ? (result.stderr || result.stdout).trim()
      : `exit ${result.status}`;
    throw new Error(`${commandName} ${args.join(" ")} failed: ${detail}`);
  }

  return options.capture ? result.stdout.trim() : "";
}

function git(...args) {
  return command("git", args, { capture: true });
}

function branchAndSha() {
  const branch = git("branch", "--show-current");
  if (!branch) {
    throw new Error(
      "Verified pushes require a checked-out branch, not detached HEAD"
    );
  }
  if (!ALLOWED_BRANCH.test(branch)) {
    throw new Error(
      `Branch ${branch} does not follow feat/, fix/, chore/, or docs/ naming`
    );
  }
  return { branch, sha: git("rev-parse", "HEAD") };
}

function receiptFor(sha) {
  const path = resolve(
    ROOT,
    git("rev-parse", "--git-path", "local-ci/receipt.json")
  );
  if (!existsSync(path)) {
    throw new Error(`No local CI receipt exists for ${sha}`);
  }
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  if (receipt.version !== 1 || receipt.sha !== sha) {
    throw new Error(`The local CI receipt does not match ${sha}`);
  }
  return receipt;
}

function githubRepository() {
  const origin = git("remote", "get-url", "origin");
  const match = origin.match(GITHUB_ORIGIN);
  if (!match) {
    throw new Error(`Cannot derive a GitHub repository from origin: ${origin}`);
  }
  return match[1];
}

function assertRemoteMatches(branch, sha) {
  const remoteSha = git("rev-parse", `refs/remotes/origin/${branch}`);
  if (remoteSha !== sha) {
    throw new Error(
      `origin/${branch} is ${remoteSha}, not locally validated ${sha}`
    );
  }
}

function sleep(milliseconds) {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    0,
    0,
    milliseconds
  );
}

function openPullRequest(branch) {
  const pullRequests = JSON.parse(
    command(
      "gh",
      [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "open",
        "--limit",
        "1",
        "--json",
        "headRefOid,isDraft,number,url",
      ],
      { capture: true }
    )
  );
  return pullRequests[0] ?? null;
}

function workflowRunId(sha) {
  const runs = JSON.parse(
    command(
      "gh",
      [
        "run",
        "list",
        "--workflow",
        "ci.yml",
        "--commit",
        sha,
        "--event",
        "pull_request",
        "--limit",
        "20",
        "--json",
        "createdAt,databaseId,headSha",
      ],
      { capture: true }
    )
  );
  return runs
    .filter((run) => run.headSha === sha)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
    ?.databaseId;
}

function waitForRequiredCheck(branch, sha, { pullRequestRequired }) {
  const pullRequest = openPullRequest(branch);
  if (!pullRequest) {
    if (pullRequestRequired) {
      throw new Error(`No open pull request exists for ${branch}`);
    }
    return;
  }
  if (pullRequest.headRefOid !== sha) {
    throw new Error(
      `PR #${pullRequest.number} points at ${pullRequest.headRefOid}, not ${sha}`
    );
  }
  if (pullRequest.isDraft) {
    process.stdout.write(
      `PR #${pullRequest.number} is a draft; required checks start when it becomes ready.\n`
    );
    return;
  }

  process.stdout.write(
    `Waiting for GitHub's required check on PR #${pullRequest.number}...\n`
  );
  for (
    let attempt = 1;
    attempt <= WORKFLOW_REGISTRATION_ATTEMPTS;
    attempt += 1
  ) {
    const runId = workflowRunId(sha);
    if (runId) {
      command("gh", [
        "run",
        "watch",
        String(runId),
        "--compact",
        "--exit-status",
      ]);
      process.stdout.write(
        `Required GitHub check passed for PR #${pullRequest.number}.\n`
      );
      return;
    }
    if (attempt < WORKFLOW_REGISTRATION_ATTEMPTS) {
      sleep(WORKFLOW_REGISTRATION_INTERVAL_MS);
    }
  }

  throw new Error(
    `GitHub did not register ci.yml for exact commit ${sha} within 90 seconds`
  );
}

function attest(branch, sha) {
  const receipt = receiptFor(sha);
  assertRemoteMatches(branch, sha);
  const repository = githubRepository();
  const targetUrl = `https://github.com/${repository}/commit/${sha}`;
  const description = `Local gate passed ${receipt.completedAt.slice(0, 16).replace("T", " ")} UTC`;

  command("gh", [
    "api",
    "--method",
    "POST",
    `repos/${repository}/statuses/${sha}`,
    "-f",
    "state=success",
    "-f",
    "context=local-ci",
    "-f",
    `description=${description}`,
    "-f",
    `target_url=${targetUrl}`,
  ]);
  process.stdout.write(`Published required local-ci status for ${sha}.\n`);
}

function pushVerified() {
  const { branch, sha } = branchAndSha();
  command("pnpm", ["ci:local"]);
  receiptFor(sha);
  command("git", ["push", "--set-upstream", "origin", branch]);
  assertRemoteMatches(branch, sha);
  attest(branch, sha);
  return { branch, sha };
}

function main() {
  const [, , mode] = process.argv;
  const passthrough = process.argv
    .slice(3)
    .filter((argument) => argument !== "--");

  if (mode === "attest") {
    const { branch, sha } = branchAndSha();
    attest(branch, sha);
    return;
  }

  if (mode === "push") {
    const { branch, sha } = pushVerified();
    waitForRequiredCheck(branch, sha, { pullRequestRequired: false });
    return;
  }

  if (mode === "pr") {
    const { branch, sha } = pushVerified();
    command("gh", [
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      branch,
      ...passthrough,
    ]);
    waitForRequiredCheck(branch, sha, { pullRequestRequired: true });
    return;
  }

  throw new Error(
    "Usage: verified-pr.mjs <attest|push|pr> [gh pr create arguments]"
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`Verified workflow failed: ${error.message ?? error}\n`);
  process.exit(1);
}
