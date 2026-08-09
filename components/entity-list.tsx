import Link from "next/link";
import { Badge } from "@/components/ui/badge";

interface EntityListItem {
  href: string;
  id: string;
  meta?: string;
  name: string;
}

export function EntityList({
  emptyLabel,
  items,
}: {
  emptyLabel: string;
  items: EntityListItem[];
}) {
  if (items.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-6 text-center text-muted-foreground text-sm">
        {emptyLabel}
      </p>
    );
  }

  return (
    <ul className="divide-y rounded-md border">
      {items.map((item) => (
        <li key={item.id}>
          <Link
            className="flex items-center justify-between px-4 py-3 hover:bg-muted/50"
            href={item.href}
          >
            <span className="font-medium text-sm">{item.name}</span>
            {item.meta ? <Badge variant="outline">{item.meta}</Badge> : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}
