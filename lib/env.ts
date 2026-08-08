import { z } from "zod";

const serverEnvSchema = z.object({
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url().default("http://localhost:3000"),
  DATABASE_URL: z.url(),
});

export const env = serverEnvSchema.parse(process.env);
