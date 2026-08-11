import { Client } from "pg";

// Read-only verification queries against the database the app under test
// writes to. Some pipeline output has no user-visible surface — artifact
// size_bytes was NULL on every row ever written and nothing looked wrong —
// so for those the database is the only place a regression can be caught.
//
// Connects with the owner/migration URL, a superuser in dev and CI, so RLS
// does not hide rows: this asserts what the pipeline persisted and is not a
// tenancy check (tests/rls-isolation.test.ts owns that). Playwright does not
// read .env on its own; playwright.config.ts loads it.
export async function queryRows<T extends Record<string, unknown>>(
  text: string,
  values: unknown[] = []
): Promise<T[]> {
  const connectionString = process.env.MIGRATE_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "MIGRATE_DATABASE_URL is required for e2e database assertions (see .env.example)"
    );
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query(text, values);
    return result.rows as T[];
  } finally {
    await client.end();
  }
}
