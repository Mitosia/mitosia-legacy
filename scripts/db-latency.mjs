#!/usr/bin/env node

// Measures what the app actually pays to reach its database, so "the app
// feels slow" can be answered with numbers instead of guesses.
//
// Reports three things, because they fail for different reasons:
//   connect    — TCP + TLS + SCRAM. Paid on every request when the pool has
//                let its connections go idle. ~1.5s across a continent.
//   query      — one round trip. The floor for anything the app does.
//   org scope  — BEGIN + set_config + SELECT + COMMIT, the real cost of one
//                withOrgScope() call. Four round trips, so it magnifies
//                distance by 4x and is the number that decides page speed.
//
// Usage: pnpm db:latency   (reads DATABASE_URL from .env)

import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write("DATABASE_URL is required\n");
  process.exit(1);
}

const ROUNDS = 5;
const ORG_ID = "00000000-0000-0000-0000-000000000000";

function summarise(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return `min=${sorted[0]}ms median=${median}ms max=${sorted.at(-1)}ms`;
}

const host = new URL(url).hostname;
process.stdout.write(`host  ${host}\n`);

// Sequential on purpose throughout: these measure one round trip at a time.
// Running them concurrently would measure the link's parallelism instead of
// its latency, which is not what makes a page slow.
const connectSamples = [];
for (let i = 0; i < 3; i += 1) {
  const started = Date.now();
  const probe = new Client({ connectionString: url });
  // biome-ignore lint/performance/noAwaitInLoops: measuring serial latency is the point
  await probe.connect();
  connectSamples.push(Date.now() - started);
  await probe.end();
}
process.stdout.write(`connect     ${summarise(connectSamples)}\n`);

const client = new Client({ connectionString: url });
await client.connect();

const querySamples = [];
for (let i = 0; i < ROUNDS; i += 1) {
  const started = Date.now();
  // biome-ignore lint/performance/noAwaitInLoops: measuring serial latency is the point
  await client.query("SELECT 1");
  querySamples.push(Date.now() - started);
}
process.stdout.write(`query       ${summarise(querySamples)}\n`);

// The shape withOrgScope produces, measured end to end rather than modelled.
const scopeSamples = [];
for (let i = 0; i < ROUNDS; i += 1) {
  const started = Date.now();
  // biome-ignore lint/performance/noAwaitInLoops: measuring serial latency is the point
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.organization_id', $1, true)", [
    ORG_ID,
  ]);
  await client.query("SELECT 1");
  await client.query("COMMIT");
  scopeSamples.push(Date.now() - started);
}
process.stdout.write(`org scope   ${summarise(scopeSamples)}\n`);

await client.end();
