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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  authClient,
  useActiveOrganization,
  useListOrganizations,
} from "@/lib/auth-client";

export function OrgSwitcher() {
  const { isMobile } = useSidebar();
  const router = useRouter();
  const { data: organizations } = useListOrganizations();
  const { data: activeOrganization } = useActiveOrganization();

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
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">
                {activeOrganization?.name ?? "Select organization"}
              </span>
              <span className="truncate text-xs">Organization</span>
            </div>
            <HugeiconsIcon
              className="ml-auto"
              icon={UnfoldMoreIcon}
              strokeWidth={2}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-(--anchor-width) min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-muted-foreground text-xs">
                Organizations
              </DropdownMenuLabel>
              {(organizations ?? []).map((organization) => (
                <DropdownMenuItem
                  className="gap-2 p-2"
                  data-org-id={organization.id}
                  key={organization.id}
                  onClick={handleSelect}
                >
                  {organization.name}
                  {organization.id === activeOrganization?.id ? " ✓" : ""}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="gap-2 p-2"
              nativeButton={false}
              render={<Link href="/onboarding" />}
            >
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
              New organization
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
