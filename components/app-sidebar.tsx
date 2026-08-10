"use client";

import {
  DashboardSquare01Icon,
  UserGroupIcon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { NavMain } from "@/components/nav-main";
import { NavUser } from "@/components/nav-user";
import { OrgSwitcher } from "@/components/org/org-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar";

const NAV_ITEMS = [
  {
    icon: <HugeiconsIcon icon={DashboardSquare01Icon} strokeWidth={2} />,
    title: "Dashboard",
    url: "/dashboard",
  },
  {
    icon: <HugeiconsIcon icon={UserGroupIcon} strokeWidth={2} />,
    title: "Clients",
    url: "/clients",
  },
  {
    icon: <HugeiconsIcon icon={UserMultiple02Icon} strokeWidth={2} />,
    title: "Members",
    url: "/settings/members",
  },
];

export function AppSidebar({
  activeOrgName,
  user,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  activeOrgName: string | null;
  user: { email: string; name: string };
}) {
  return (
    <Sidebar collapsible="icon" {...props}>
      {/* SidebarHeader and SidebarContent ship with [--radius:var(--radius-xl)],
          rounding their controls one notch more than the footer. Reset both to
          the base radius so the whole sidebar — org switcher, nav items, and
          profile — shares one consistent corner radius. */}
      <SidebarHeader className="[--radius:0.625rem]">
        <OrgSwitcher activeOrgName={activeOrgName} />
      </SidebarHeader>
      <SidebarContent className="[--radius:0.625rem]">
        <NavMain items={NAV_ITEMS} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
