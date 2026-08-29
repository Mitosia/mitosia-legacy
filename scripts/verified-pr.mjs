#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_BRANCH = /^(chore|docs|feat|fix)\//;
const GITHUB_ORIGIN = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/;

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
    pushVerified();
    return;
  }

  if (mode === "pr") {
    const { branch } = pushVerified();
    command("gh", [
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      branch,
      ...passthrough,
    ]);
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
