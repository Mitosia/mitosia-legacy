import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

// Release-phase migration runner: bundled by the Dockerfile and executed by
// docker-entrypoint.sh before the server starts. Never run at build time —
// the image must stay environment-agnostic.

// Arbitrary constant: any concurrent deploy takes this same lock, so replicas
// starting together migrate one at a time instead of racing.
const MIGRATION_LOCK_ID = 727_314_159;

async function main() {
  // Prefer the owner connection: the runtime DATABASE_URL role is
  // deliberately unprivileged (no DDL) so that RLS applies to the app.
  const connectionString =
    process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "MIGRATE_DATABASE_URL or DATABASE_URL is required to run migrations"
    );
  }

  const pool = new Pool({ connectionString });
  // Advisory locks are session-scoped, so hold it on a dedicated connection
  // while the migrator works on another.
  const lockHolder = await pool.connect();

  try {
    await lockHolder.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
    process.stdout.write("migrations applied\n");
  } finally {
    await lockHolder.query("SELECT pg_advisory_unlock($1)", [
      MIGRATION_LOCK_ID,
    ]);
    lockHolder.release();
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`migration failed: ${error}\n`);
  process.exit(1);
});
