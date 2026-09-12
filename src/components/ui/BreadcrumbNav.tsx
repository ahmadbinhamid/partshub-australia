import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronRight, ArrowLeft } from "lucide-react";
import { cn } from "@/utils/cn";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface BreadcrumbNavProps {
  items: BreadcrumbItem[];
  className?: string;
  // Set false to hide the back button — e.g. a page that's always a direct
  // entry point rather than reached by drilling in from somewhere.
  showBack?: boolean;
}

export function BreadcrumbNav({ items, className, showBack = true }: BreadcrumbNavProps) {
  const navigate = useNavigate();

  return (
    <nav
      aria-label="Breadcrumb"
      className={cn("flex items-center gap-1.5 text-xs text-fg/50", className)}
    >
      {showBack && (
        <>
          <button
            type="button"
            onClick={() => navigate(-1)}
            aria-label="Go back"
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-fg/50 transition hover:bg-bg-2 hover:text-fg"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <span className="h-3 w-px shrink-0 bg-border" aria-hidden />
        </>
      )}
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        return (
          <React.Fragment key={i}>
            {i > 0 && (
              <ChevronRight className="h-3 w-3 shrink-0 text-fg/30" aria-hidden />
            )}
            {isLast || !item.href ? (
              <span
                className={cn(
                  "min-w-0 truncate",
                  isLast ? "font-medium text-fg" : "shrink hover:text-fg transition",
                )}
              >
                {item.label}
              </span>
            ) : (
              <Link
                to={item.href}
                className="min-w-0 shrink truncate transition hover:text-fg"
              >
                {item.label}
              </Link>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}
