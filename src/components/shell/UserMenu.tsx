import { useNavigate } from "react-router-dom";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/ActionsMenu";
import { useAuth } from "@/context/auth";
import { useThemePreference, type ThemePreference } from "@/hooks";
import { cn } from "@/utils/cn";
import { ChevronsUpDown, History, LogOut, Moon, Settings, Sun } from "lucide-react";

function initials(firstName: string, lastName: string) {
  const a = firstName.trim().charAt(0);
  const b = lastName.trim().charAt(0);
  return (a + b || a || "PH").toUpperCase();
}

const ROLE_LABEL: Record<string, string> = {
  superadmin: "Super Admin",
  admin: "Admin",
  user: "User",
};

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

// "compact" (Topbar) is a plain link straight to /profile — no dropdown.
// "full" (Sidebar footer) also shows name + role and opens the account
// panel: identity, the Light/Dark theme control (shares state with the
// Topbar's own quick ThemeToggle via useThemePreference — an external
// store, so flipping the theme from either place updates both instantly),
// then Settings/Activity Log/Sign Out.
export function UserMenu({ variant = "compact" }: { variant?: "compact" | "full" }) {
  const { user, logout } = useAuth();
  const { preference, setTheme } = useThemePreference();
  const navigate = useNavigate();

  if (!user) return null;

  const fullName = `${user.first_name} ${user.last_name}`.trim();
  const avatar = (
    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-fg text-[11px] font-semibold text-bg">
      {initials(user.first_name, user.last_name)}
    </span>
  );

  function handleLogout() {
    logout();
    navigate("/login", { replace: true });
  }

  if (variant === "compact") {
    return (
      <button
        type="button"
        onClick={() => navigate("/profile")}
        className="h-9 w-9 shrink-0 rounded-full transition hover:opacity-85"
        aria-label="Go to profile"
        title={fullName || "Profile"}
      >
        {avatar}
      </button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left transition-colors hover:bg-muted/60"
        >
          {avatar}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold leading-tight text-fg">{fullName || "Account"}</div>
            <div className="truncate text-[11px] text-fg/50">{ROLE_LABEL[user.role] ?? user.role}</div>
          </div>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-fg/35" />
        </button>
      </DropdownMenuTrigger>

      {/* Sidebar is w-65 (260px) — the panel sits 8px in from each of its
          edges (244px wide), not flush. The trigger itself is already inset
          8px by the footer wrapper's p-2 (Sidebar.tsx), and Radix aligns to
          the TRIGGER's edge, not the sidebar's — since that 8px inset is
          exactly the gap we want, no alignOffset correction is needed here
          (unlike the previous 4px gap, which had to compensate for it). */}
      <DropdownMenuContent
        align="start"
        className="w-61 p-0"
      >
        <div className="px-3 py-2.5">
          <div className="truncate text-[13px] font-semibold text-fg">{fullName || "Account"}</div>
          <div className="truncate text-xs text-fg/50">{user.email}</div>
        </div>

        <DropdownMenuSeparator className="mx-0" />

        <div className="px-3 py-2.5">
          <span className="text-xs text-fg/55">Theme</span>
          <div className="mt-2 grid grid-cols-2 gap-1">
            {THEME_OPTIONS.map((opt) => {
              const active = preference === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    setTheme(opt.value);
                  }}
                  className={cn(
                    "flex items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                    active ? "bg-accent/10 text-accent" : "text-fg/60 hover:bg-muted/60",
                  )}
                >
                  <opt.icon className="h-3.5 w-3.5" />
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        <DropdownMenuSeparator className="mx-0" />

        <div className="p-1">
          <DropdownMenuItem className="px-2 py-1.5 text-xs" onSelect={() => navigate("/settings")}>
            <Settings className="h-3.5 w-3.5" />
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem className="px-2 py-1.5 text-xs" onSelect={() => navigate("/activity-log")}>
            <History className="h-3.5 w-3.5" />
            Activity Log
          </DropdownMenuItem>
        </div>

        <DropdownMenuSeparator className="mx-0" />

        <div className="p-1">
          <DropdownMenuItem className="px-2 py-1.5 text-xs" destructive onSelect={handleLogout}>
            <LogOut className="h-3.5 w-3.5" />
            Sign Out
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
