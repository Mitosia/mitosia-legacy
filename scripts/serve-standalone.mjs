// Serves the standalone production build the way the Docker image does:
// `.next/static` and `public` are not bundled into `.next/standalone` by
// `next build`, so the Dockerfile copies them in beside `server.js`. This
// script does the same for local runs, which is what makes the
// production-parity e2e (playwright.prod.config.ts) and the
// `mitosia-prod-local` launch config faithful rather than approximate.
//
// Requires a prior `pnpm build`; it deliberately refuses to start rather
// than serve a stale or missing build.
import { spawn } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const standalone = join(root, ".next", "standalone");
const server = join(standalone, "server.js");

if (!existsSync(server)) {
  process.stderr.write(
    `No standalone build at ${server}\nRun \`pnpm build\` first.\n`
  );
  process.exit(1);
}

for (const [from, to] of [
  [join(root, ".next", "static"), join(standalone, ".next", "static")],
  [join(root, "public"), join(standalone, "public")],
]) {
  if (existsSync(from)) {
    rmSync(to, { force: true, recursive: true });
    cpSync(from, to, { recursive: true });
  }
}

const child = spawn(process.execPath, ["server.js"], {
  cwd: standalone,
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
