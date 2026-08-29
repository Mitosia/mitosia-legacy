#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const repository = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  stdio: "ignore",
});

if (repository.status !== 0) {
  process.stdout.write(
    "Git hooks not installed (this is not a Git checkout).\n"
  );
  process.exit(0);
}

const install = spawnSync(
  "git",
  ["config", "--local", "core.hooksPath", ".githooks"],
  { stdio: "inherit" }
);

if (install.status !== 0) {
  process.stderr.write("Could not configure the repository Git hooks.\n");
  process.exit(install.status ?? 1);
}

process.stdout.write("Repository Git hooks installed from .githooks/.\n");
