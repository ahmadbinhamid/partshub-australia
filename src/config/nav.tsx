import {
  LayoutDashboard,
  Package,
  Layers,
  Users,
  ShoppingCart,
  CreditCard,
  Boxes,
  History,
  Settings,
} from "lucide-react";

export type NavItem = {
  label: string;
  href: string;
  icon: (props: React.SVGProps<SVGSVGElement>) => React.ReactNode;
  // Extra path prefixes that should also count as "this nav item is
  // active" — Catalogue's own create/edit sub-routes stayed at their
  // original /products, /listings paths (not moved under /catalogue) when
  // Products+Listings merged into one tabbed page, so the plain
  // startsWith(href) check below wouldn't highlight Catalogue while on
  // e.g. /products/new or /listings/:id/edit without this.
  activeMatch?: string[];
};

export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: (p) => <LayoutDashboard {...p} /> },
  { label: "Catalogue", href: "/catalogue", icon: (p) => <Package {...p} />, activeMatch: ["/products", "/listings"] },
  { label: "Categories", href: "/categories", icon: (p) => <Layers {...p} /> },
  { label: "Inventory", href: "/inventory", icon: (p) => <Boxes {...p} /> },
  { label: "Customers", href: "/customers", icon: (p) => <Users {...p} /> },
  { label: "Orders", href: "/orders", icon: (p) => <ShoppingCart {...p} /> },
  { label: "Payments", href: "/payments", icon: (p) => <CreditCard {...p} /> },
  { label: "Activity Log", href: "/activity-log", icon: (p) => <History {...p} /> },
  { label: "Settings", href: "/settings", icon: (p) => <Settings {...p} /> },
];

export function isNavItemActive(item: Pick<NavItem, "href" | "activeMatch">, pathname: string): boolean {
  const { href, activeMatch } = item;
  if (href === "/") return pathname === "/";
  const prefixes = [href, ...(activeMatch ?? [])];
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
