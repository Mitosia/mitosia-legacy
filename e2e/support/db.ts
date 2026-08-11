import { Client } from "pg";

// Verification queries against the database the app under test writes to.
// Some pipeline output has no user-visible surface — artifact size_bytes
// was NULL on every row ever written and nothing looked wrong — so for
// those the database is the only place a regression can be caught.
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

// The one write, and only because a test cannot otherwise make time pass:
// the stale-upload reaper acts on a full idle window. `updated_at` is
// exactly what an abandoned upload stops moving, so back-dating it is a
// faithful simulation rather than a shortcut around the logic under test.
// Same trick at a finer grain. Server-side adoption only takes over an
// upload that has been quiet longer than UPLOAD_ADOPT_GRACE_SECONDS, so a
// test that just interrupted one has to let it fall past that line without
// waiting out the real window.
export async function quietUpload(
  sourceId: string,
  seconds: number
): Promise<void> {
  const rows = await queryRows(
    `UPDATE source SET updated_at = now() - make_interval(secs => $2)
     WHERE id = $1 AND status = 'uploading' RETURNING id`,
    [sourceId, seconds]
  );
  if (rows.length !== 1) {
    throw new Error(
      `expected one uploading source ${sourceId}, updated ${rows.length}`
    );
  }
}

export async function ageUpload(
  sourceId: string,
  hours: number
): Promise<void> {
  const rows = await queryRows(
    `UPDATE source SET updated_at = now() - make_interval(hours => $2)
     WHERE id = $1 AND status = 'uploading' RETURNING id`,
    [sourceId, hours]
  );
  if (rows.length !== 1) {
    throw new Error(
      `expected one uploading source ${sourceId}, updated ${rows.length}`
    );
  }
}
