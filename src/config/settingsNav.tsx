import { Building2, CreditCard, Globe, Link2, Mail, ShoppingBag, ShoppingCart } from "lucide-react";

export type SettingsNavItem = {
  label: string;
  href: string;
  icon: (props: React.SVGProps<SVGSVGElement>) => React.ReactNode;
};

export type SettingsNavSection = {
  label: string;
  items: SettingsNavItem[];
};

export const SETTINGS_NAV_SECTIONS: SettingsNavSection[] = [
  {
    label: "ORGANISATION",
    items: [
      { label: "Business Info", href: "/settings/business-info", icon: (p) => <Building2 {...p} /> },
      { label: "Payment Account", href: "/settings/payment-account", icon: (p) => <CreditCard {...p} /> },
      { label: "Payment Settings", href: "/settings/payment-settings", icon: (p) => <Globe {...p} /> },
      { label: "Email Settings", href: "/settings/email", icon: (p) => <Mail {...p} /> },
      { label: "eBay Integration", href: "/settings/ebay", icon: (p) => <ShoppingBag {...p} /> },
      { label: "Google Shopping", href: "/settings/google", icon: (p) => <ShoppingCart {...p} /> },
      { label: "Domains", href: "/settings/domains", icon: (p) => <Link2 {...p} /> },
    ],
  },
];

export function isSettingsNavActive(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
