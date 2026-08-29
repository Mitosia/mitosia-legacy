import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import { asc, eq } from "drizzle-orm";
import { after } from "next/server";
import { db } from "./db";
import * as schema from "./db/schema";
import { sendPasswordResetEmail } from "./email/send-password-reset-email";
import { env } from "./env";

const PASSWORD_RESET_TOKEN_EXPIRES_IN_SECONDS = 60 * 60;

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
    // Better Auth hands non-critical email work to Next's request lifecycle,
    // which keeps the response timing independent of Resend latency while
    // still allowing the Docker server to drain the task on shutdown.
    backgroundTasks: { handler: after },
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
    resetPasswordTokenExpiresIn: PASSWORD_RESET_TOKEN_EXPIRES_IN_SECONDS,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      try {
        await sendPasswordResetEmail({
          name: user.name,
          resetUrl: url,
          to: user.email,
        });
      } catch (error) {
        // The browser always receives Better Auth's generic response for both
        // known and unknown addresses. Surfacing delivery failures here would
        // turn the endpoint into an account-enumeration oracle.
        console.error("[auth] password reset email delivery failed", error);
      }
    },
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
