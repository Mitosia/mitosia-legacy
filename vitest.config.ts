import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirror tsconfig's "@/*" so unit tests can import lib modules that use
    // the app-wide alias.
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    hookTimeout: 60_000,
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
