import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import { asc, eq } from "drizzle-orm";
import { db } from "./db";
import * as schema from "./db/schema";
import { env } from "./env";

export const auth = betterAuth({
  // Behind Cloudflare the socket address is always an edge server, so Better
  // Auth cannot resolve a client IP on its own — it records an empty
  // `session.ip_address` and, worse, silently drops rate limiting into "a
  // single shared per-path bucket" (its own warning), where one abusive
  // client consumes the limit for everybody.
  //
  // `cf-connecting-ip` is set by Cloudflare to the true client address and is
  // the only header here that cannot be influenced by the client. It is
  // trustworthy *because* the origin only accepts connections from Cloudflare
  // (scripts/cloudflare-origin-lock.sh) — without that lock, anyone reaching
  // the origin directly could set this header to whatever they liked and
  // forge the address in audit records and rate limit buckets.
  advanced: {
    ipAddress: {
      ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"],
    },
  },
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

  return {
    data: {
      ...session,
      activeOrganizationId: firstMembership?.organizationId ?? null,
    },
  };
}
