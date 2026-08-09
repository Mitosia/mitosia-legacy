"use client";

import { ArrowDown01Icon, Building01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  authClient,
  useActiveOrganization,
  useListOrganizations,
} from "@/lib/auth-client";

export function OrgSwitcher() {
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
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline">
            <HugeiconsIcon
              className="size-4"
              icon={Building01Icon}
              strokeWidth={2}
            />
            {activeOrganization?.name ?? "Select organization"}
            <HugeiconsIcon
              className="size-4"
              icon={ArrowDown01Icon}
              strokeWidth={2}
            />
          </Button>
        }
      />
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        {(organizations ?? []).map((organization) => (
          <DropdownMenuItem
            data-org-id={organization.id}
            key={organization.id}
            onClick={handleSelect}
          >
            {organization.name}
            {organization.id === activeOrganization?.id ? " ✓" : ""}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/onboarding" />}>
          New organization
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
