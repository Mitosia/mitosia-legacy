"use client";

import {
  Building01Icon,
  PlusSignIcon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { authClient, useListOrganizations } from "@/lib/auth-client";

// ⌘1..⌘9 shortcuts are shown only for the first nine organizations.
const MAX_SHORTCUTS = 9;

// activeOrgName comes from the server layout, NOT from the client-side
// useActiveOrganization store: SSR'd text derived from an async client store
// hydrates against whatever the store holds at that instant, which is an
// intermittent React #418 in prod. The server prop is stable through
// hydration, and org switches propagate through router.refresh().
export function OrgSwitcher({
  activeOrgName,
}: {
  activeOrgName: string | null;
}) {
  const { isMobile } = useSidebar();
  const router = useRouter();
  const { data: organizations } = useListOrganizations();

  const handleSelect = useCallback(
    async (event: React.MouseEvent<HTMLElement>) => {
      const organizationId = event.currentTarget.dataset.orgId;
      if (!organizationId) {
        return;
      }
      await authClient.organization.setActive({ organizationId });
      router.refresh();
    },
    [router]
  );

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                className="data-[popup-open]:bg-sidebar-accent data-[popup-open]:text-sidebar-accent-foreground"
                size="lg"
              />
            }
          >
            <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
              <HugeiconsIcon
                className="size-4"
                icon={Building01Icon}
                strokeWidth={2}
              />
            </div>
            <div className="grid flex-1 text-start text-sm leading-tight">
              <span className="truncate font-medium">
                {activeOrgName ?? "Select organization"}
              </span>
              <span className="truncate text-muted-foreground text-xs">
                Organization
              </span>
            </div>
            <HugeiconsIcon
              className="ms-auto"
              icon={UnfoldMoreIcon}
              strokeWidth={2}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-(--anchor-width) min-w-60"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-muted-foreground text-xs">
                Organizations
              </DropdownMenuLabel>
              {(organizations ?? []).map((organization, index) => (
                <DropdownMenuItem
                  className="gap-2 p-2"
                  data-org-id={organization.id}
                  key={organization.id}
                  onClick={handleSelect}
                >
                  <div className="flex size-6 items-center justify-center rounded-md border">
                    <HugeiconsIcon
                      className="size-3.5 shrink-0"
                      icon={Building01Icon}
                      strokeWidth={2}
                    />
                  </div>
                  <span className="truncate">{organization.name}</span>
                  {index < MAX_SHORTCUTS ? (
                    <DropdownMenuShortcut>⌘{index + 1}</DropdownMenuShortcut>
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                className="gap-2 p-2"
                nativeButton={false}
                render={<Link href="/onboarding" />}
              >
                <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                  <HugeiconsIcon
                    className="size-4"
                    icon={PlusSignIcon}
                    strokeWidth={2}
                  />
                </div>
                <div className="font-medium text-muted-foreground">
                  New organization
                </div>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
