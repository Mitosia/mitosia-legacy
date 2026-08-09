import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";

export async function requireSession() {
  const session = await auth.api.getSession({ headers: await headers() });

  if (!session) {
    redirect("/sign-in");
  }

  return session;
}

// Resolves the tenant for the current request. Every org-scoped page and
// server action starts here; the returned organizationId is what feeds
// withOrgScope (and therefore RLS).
export async function requireOrg() {
  const session = await requireSession();
  const organizationId = session.session.activeOrganizationId;

  if (!organizationId) {
    redirect("/onboarding");
  }

  return {
    organizationId,
    session,
    userId: session.user.id,
  };
}
