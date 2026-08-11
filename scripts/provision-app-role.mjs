#!/usr/bin/env node

// Provisions the least-privilege role the app connects as, in a database
// that already exists. Idempotent: safe to re-run.
//
// This existed only as steps someone once typed into psql, which is a bad
// way to hold a security boundary. The app's role must never be a superuser
// or a table owner, because both bypass RLS *silently* — the query returns
// more rows and nothing errors. That exact mistake shipped once already: the
// CI e2e ran as the `ci` superuser, RLS was disabled without a symptom, and
// a Playwright retry walked into a previous attempt's tenant (PR #16).
//
// Usage:
//   PROVISION_DATABASE_URL=<owner/admin connection string> \
//   APP_ROLE_PASSWORD=<password for the app role> \
//   node scripts/provision-app-role.mjs [--role mitosia_app]
//
// The owner URL becomes MIGRATE_DATABASE_URL (drizzle-kit and the container
// entrypoint); the app role becomes DATABASE_URL.

import { Client } from "pg";

const ownerUrl = process.env.PROVISION_DATABASE_URL;
const password = process.env.APP_ROLE_PASSWORD;
const roleIndex = process.argv.indexOf("--role");
const role = roleIndex === -1 ? "mitosia_app" : process.argv[roleIndex + 1];

if (!(ownerUrl && password)) {
  process.stderr.write(
    "PROVISION_DATABASE_URL and APP_ROLE_PASSWORD are required\n"
  );
  process.exit(1);
}
if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
  process.stderr.write(`refusing unsafe role name: ${role}\n`);
  process.exit(1);
}

const client = new Client({ connectionString: ownerUrl });
await client.connect();

try {
  const { rows: existing } = await client.query(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1",
    [role]
  );

  // CREATE/ALTER ROLE are utility statements: they take no bind parameters,
  // so the password has to be a literal. escapeLiteral is the driver's own
  // quoting, not string concatenation by hand.
  const quotedPassword = client.escapeLiteral(password);

  if (existing.length === 0) {
    // LOGIN only: no CREATEDB, no CREATEROLE, and emphatically no SUPERUSER
    // or BYPASSRLS.
    await client.query(
      `CREATE ROLE ${role} LOGIN PASSWORD ${quotedPassword}`
    );
    process.stdout.write(`created role ${role}\n`);
  } else {
    await client.query(
      `ALTER ROLE ${role} WITH LOGIN PASSWORD ${quotedPassword}`
    );
    process.stdout.write(`role ${role} already existed — password reset\n`);
  }

  const { rows: dbRows } = await client.query("SELECT current_database() AS db");
  const database = dbRows[0].db;

  await client.query(`GRANT CONNECT ON DATABASE "${database}" TO ${role}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`
  );
  await client.query(
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`
  );

  // The half that is easy to forget and breaks the *next* migration rather
  // than this one: tables created later must be reachable too.
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role}`
  );

  // Verify rather than assume: this is the property that matters, and it is
  // invisible at runtime when it is wrong.
  const { rows: check } = await client.query(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1",
    [role]
  );
  const { rows: owned } = await client.query(
    "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = $1",
    [role]
  );

  const problems = [];
  if (check[0]?.rolsuper) {
    problems.push("is a SUPERUSER — it would bypass every RLS policy");
  }
  if (check[0]?.rolbypassrls) {
    problems.push("has BYPASSRLS — it would bypass every RLS policy");
  }
  if (owned[0]?.n > 0) {
    problems.push(
      `owns ${owned[0].n} table(s) — owners bypass RLS unless FORCE is set on every one`
    );
  }

  if (problems.length > 0) {
    process.stderr.write(
      [`${role} is not safe to use as DATABASE_URL:`, ...problems.map((p) => `  - ${p}`), ""].join(
        "\n"
      )
    );
    process.exit(1);
  }

  process.stdout.write(
    `ok  ${role} has table access on "${database}", owns nothing, and cannot bypass RLS\n`
  );
} finally {
  await client.end();
}
