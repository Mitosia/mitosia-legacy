import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dbCredentials: {
    // biome-ignore lint/style/noNonNullAssertion: validated by lib/env.ts at runtime; drizzle-kit runs outside the app
    url: process.env.DATABASE_URL!,
  },
  dialect: "postgresql",
  out: "./drizzle",
  schema: "./lib/db/schema/index.ts",
});
