import Link from "next/link";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { OrgSwitcher } from "@/components/org/org-switcher";
import { requireSession } from "@/lib/org";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/clients", label: "Clients" },
  { href: "/settings/members", label: "Members" },
] as const;

export default async function AppLayout({ children }: LayoutProps<"/">) {
  await requireSession();

  return (
    <div className="flex min-h-svh flex-1">
      <aside className="flex w-56 flex-col border-r bg-muted/30">
        <div className="border-b px-4 py-4">
          <Link className="font-semibold text-lg" href="/dashboard">
            Mitosia
          </Link>
        </div>
        <nav className="flex flex-1 flex-col gap-1 p-2">
          {NAV_ITEMS.map((item) => (
            <Link
              className="rounded-md px-3 py-2 text-sm hover:bg-muted"
              href={item.href}
              key={item.href}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b px-6 py-3">
          <OrgSwitcher />
          <SignOutButton />
        </header>
        <main className="flex flex-1 flex-col gap-6 p-6">{children}</main>
      </div>
    </div>
  );
}
