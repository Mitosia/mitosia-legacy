#!/usr/bin/env node

// Asserts the VPS's Traefik configuration still contains the things that were
// put there by hand, and that certificates are not quietly expiring.
//
// Why this exists: /etc/dokploy/traefik/traefik.yml lives in exactly one
// place, is not deployed from this repo, and carries three settings that fail
// *silently* when absent —
//
//   forwardedHeaders.trustedIPs  every visitor looks like a Cloudflare IP, so
//                                rate limits and audit logs record the wrong
//                                address while appearing to work
//   letsencrypt-dns resolver     new subdomains get no certificate, and
//                                renewals depend on an HTTP path that
//                                Cloudflare can break
//   defaultGeneratedCert         the wildcard stops being served to hosts
//                                that have no certificate of their own
//
// Dokploy does not overwrite an existing traefik.yml — verified in its source
// (createDefaultTraefikConfig returns early when the file exists) — but it
// *does* regenerate defaults if the file is ever missing, which would drop
// all three at once.
//
// Usage:  pnpm check:traefik            (reads over ssh)
//         SSH_HOST=other pnpm check:traefik

import { execFileSync } from "node:child_process";

const HOST = process.env.SSH_HOST ?? "mitosia-vps";
// Overridable so the failure paths can be exercised against a deliberately
// broken copy, rather than by breaking the live configuration to find out
// whether the check works.
const CONFIG = process.env.TRAEFIK_CONFIG ?? "/etc/dokploy/traefik/traefik.yml";
const DYNAMIC = process.env.TRAEFIK_DYNAMIC ?? "/etc/dokploy/traefik/dynamic";
// Renew well before the edge: Let's Encrypt certificates last 90 days and
// Traefik renews at 30 remaining, so anything under this means renewal has
// already failed at least once rather than simply not being due.
const MIN_CERT_DAYS = 21;

// Retried, because the link to this host is intermittently unreliable — the
// route from at least one Indian ISP to the VPS drops for minutes at a time
// (the reason Cloudflare is in front of it at all). A monitor that reports
// "your configuration has drifted" when it simply could not connect is worse
// than no monitor: it teaches you to ignore it.
const SSH_ATTEMPTS = 3;
const SSH_RETRY_MS = 3000;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ssh(command) {
  let lastError;
  for (let attempt = 1; attempt <= SSH_ATTEMPTS; attempt += 1) {
    try {
      return execFileSync(
        "ssh",
        ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", HOST, command],
        { encoding: "utf8", timeout: 60_000 }
      );
    } catch (error) {
      lastError = error;
      if (attempt < SSH_ATTEMPTS) {
        sleep(SSH_RETRY_MS);
      }
    }
  }
  throw lastError;
}

// An unreachable host is not drift. Exits distinctly so a network blip never
// looks like a configuration problem.
function unreachable(error) {
  process.stderr.write(
    [
      `could not reach ${HOST} after ${SSH_ATTEMPTS} attempts.`,
      "",
      "This says nothing about the configuration — it means ssh failed.",
      `  ${String(error.message).split("\n")[0]}`,
      "",
    ].join("\n")
  );
  process.exit(2);
}

const problems = [];
const ok = [];

let config = "";
try {
  config = ssh(`cat ${CONFIG}`);
} catch (error) {
  unreachable(error);
}

// Cloudflare's ranges change rarely, but "some trusted IPs" is the property
// that matters; the exact list is checked by count, not by value.
const trustedCount = (config.match(/^\s+- \d+\.\d+\.\d+\.\d+\/\d+$/gm) ?? [])
  .length;
if (trustedCount < 10) {
  problems.push(
    `forwardedHeaders.trustedIPs looks wrong (${trustedCount} IPv4 ranges) — client IPs will be Cloudflare's, silently`
  );
} else {
  ok.push(`trustedIPs present (${trustedCount} IPv4 ranges)`);
}

if (config.includes("letsencrypt-dns:") && config.includes("dnsChallenge")) {
  ok.push("letsencrypt-dns resolver present");
} else {
  problems.push(
    "letsencrypt-dns resolver missing — new subdomains will have no certificate"
  );
}

let dynamic = "";
try {
  dynamic = ssh(`cat ${DYNAMIC}/wildcard-default.yml 2>/dev/null || true`);
} catch {
  dynamic = "";
}
if (dynamic.includes("defaultGeneratedCert")) {
  ok.push("wildcard default certificate configured");
} else {
  problems.push(
    "defaultGeneratedCert missing — hosts without their own certificate will fail TLS"
  );
}

// Certificate expiry, read from what the server actually serves rather than
// from any stored file: this is the number a browser will act on.
for (const host of ["staging.mitosia.cloud", "dokploy.mitosia.cloud"]) {
  let enddate = "";
  try {
    enddate = ssh(
      `echo | openssl s_client -connect 127.0.0.1:443 -servername ${host} 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null`
    ).trim();
  } catch (error) {
    unreachable(error);
  }
  const match = /notAfter=(.+)/.exec(enddate);
  if (!match) {
    // Reached the host but got no certificate — that IS a real problem.
    problems.push(`${host}: served no certificate`);
    continue;
  }
  const days = Math.floor(
    (new Date(match[1]).getTime() - Date.now()) / 86_400_000
  );
  if (days < MIN_CERT_DAYS) {
    problems.push(
      `${host}: certificate expires in ${days} days — renewal has probably already failed`
    );
  } else {
    ok.push(`${host}: certificate valid for ${days} more days`);
  }
}

for (const line of ok) {
  process.stdout.write(`ok   ${line}\n`);
}

if (problems.length > 0) {
  process.stderr.write(
    [
      "",
      "traefik configuration has drifted:",
      ...problems.map((p) => `  - ${p}`),
      "",
      "Reference copy: infra/traefik/traefik.yml",
      "",
    ].join("\n")
  );
  process.exit(1);
}
