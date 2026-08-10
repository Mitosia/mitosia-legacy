import { headers } from "next/headers";
import { auth } from "./auth";

type OrgApiContext =
  | { error: Response; organizationId?: never; userId?: never }
  | { error?: never; organizationId: string; userId: string };

// API-route counterpart of requireOrg(): route handlers return JSON errors
// instead of redirecting. The returned organizationId feeds withOrgScope
// (and therefore RLS) exactly like the page/server-action path.
export async function requireOrgApi(): Promise<OrgApiContext> {
  const session = await auth.api.getSession({ headers: await headers() });

  if (!session) {
    return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const organizationId = session.session.activeOrganizationId;

  if (!organizationId) {
    return {
      error: Response.json(
        { error: "No active organization" },
        { status: 403 }
      ),
    };
  }

  return { organizationId, userId: session.user.id };
}
