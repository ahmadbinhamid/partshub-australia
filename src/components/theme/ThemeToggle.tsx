import { cn } from "@/utils/cn";
import { Button } from "@/components/ui/Button";
import { useThemePreference } from "@/hooks";
import { Sun, Moon } from "lucide-react";

// Quick two-state flip — the same Light/Dark control also lives in
// UserMenu's account panel. Both read/write useThemePreference, an external
// store rather than local state, so toggling here updates the other
// instantly and vice versa.
export function ThemeToggle({ className }: { className?: string }) {
  const { isDark, setTheme } = useThemePreference();

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className={cn("relative h-9 w-9 p-0", className)}
      aria-label="Toggle theme"
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      <Sun className={cn("h-4 w-4 transition-all duration-300", isDark ? "-rotate-90 scale-0" : "rotate-0 scale-100")} />
      <Moon
        className={cn(
          "absolute h-4 w-4 transition-all duration-300",
          isDark ? "rotate-0 scale-100" : "rotate-90 scale-0",
        )}
      />
    </Button>
  );
}
