import { eq } from "drizzle-orm";
import { AppSidebar } from "@/components/app-sidebar";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { db } from "@/lib/db";
import { organization } from "@/lib/db/schema";
import { requireSession } from "@/lib/org";

// The sidebar's org label must be server-rendered text: deriving it from the
// Better Auth client store made SSR emit the "Select organization" fallback
// while a fast store fetch could supply the real name mid-hydration — an
// intermittent React #418 (hydration text mismatch) on prod loads.
async function activeOrgName(
  activeOrganizationId: string | null | undefined
): Promise<string | null> {
  if (!activeOrganizationId) {
    return null;
  }
  const [row] = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, activeOrganizationId))
    .limit(1);
  return row?.name ?? null;
}

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const session = await requireSession();
  const orgName = await activeOrgName(session.session.activeOrganizationId);

  return (
    <SidebarProvider>
      <AppSidebar
        activeOrgName={orgName}
        user={{ email: session.user.email, name: session.user.name }}
      />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator className="mr-2 h-4" orientation="vertical" />
          <span className="font-medium text-sm">Mitosia</span>
        </header>
        <main className="flex flex-1 flex-col gap-6 p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
