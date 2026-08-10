import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import { asc, eq } from "drizzle-orm";
import { db } from "./db";
import * as schema from "./db/schema";
import { env } from "./env";

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  databaseHooks: {
    session: {
      create: {
        before: (session) => setDefaultActiveOrganization(session),
      },
    },
  },
  emailAndPassword: {
    enabled: true,
  },
  // nextCookies must stay last so cookies set in server actions propagate
  plugins: [organization(), nextCookies()],
  secret: env.BETTER_AUTH_SECRET,
});

// Default the active organization to the user's first membership so a fresh
// sign-in lands inside a tenant without an extra selection step.
async function setDefaultActiveOrganization<
  T extends { userId: string; activeOrganizationId?: string | null },
>(session: T) {
  const [firstMembership] = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, session.userId))
    .orderBy(asc(schema.member.createdAt))
    .limit(1);

  // TEMPORARY diagnostics (PR #16): CI-only org confusion across e2e users.
  console.error("[auth] session.create", {
    resolvedOrg: firstMembership?.organizationId ?? null,
    userId: session.userId,
  });

  return {
    data: {
      ...session,
      activeOrganizationId: firstMembership?.organizationId ?? null,
    },
  };
}
