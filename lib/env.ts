import { z } from "zod";

const serverEnvSchema = z.object({
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url().default("http://localhost:3000"),
  DATABASE_URL: z.url(),
  EMAIL_FROM: z.string().min(1).default("Mitosia <auth@mitosia.com>"),
  RESEND_API_KEY: z.string().min(1).optional(),
  STORAGE_ACCESS_KEY_ID: z.string().min(1),
  STORAGE_BUCKET: z.string().min(1),
  // S3-compatible object storage: MinIO locally, Cloudflare R2 deployed.
  STORAGE_ENDPOINT: z.url(),
  // MinIO needs path-style addressing; R2 works with the default virtual-host style.
  STORAGE_FORCE_PATH_STYLE: z.stringbool().default(false),
  STORAGE_REGION: z.string().default("auto"),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1),
});

export const env = serverEnvSchema.parse(process.env);
