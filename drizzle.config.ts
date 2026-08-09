import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dbCredentials: {
    // Migrations run as the schema owner; the app itself connects with the
    // unprivileged DATABASE_URL role that RLS applies to.
    // biome-ignore lint/style/noNonNullAssertion: validated at invocation time; drizzle-kit runs outside the app
    url: (process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL)!,
  },
  dialect: "postgresql",
  out: "./drizzle",
  schema: "./lib/db/schema/index.ts",
});
