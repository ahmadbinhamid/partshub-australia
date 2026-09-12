import { useSyncExternalStore } from "react";

// Shared by ThemeToggle (quick light/dark button in the Topbar) and
// UserMenu's account panel (Light/Dark picker in the Sidebar) — an external
// store (not a plain per-component useState) is what makes changing the
// theme in one immediately reflect in the other, since both subscribe to
// the same module-level value instead of holding independent copies.
export type ThemePreference = "light" | "dark";

const STORAGE_KEY = "ppg-theme";

function systemPrefersDark() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function getInitialPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* ignore */
  }
  return systemPrefersDark() ? "dark" : "light";
}

function applyTheme(pref: ThemePreference) {
  document.documentElement.classList.toggle("dark", pref === "dark");
}

let currentPreference = getInitialPreference();
applyTheme(currentPreference);

const listeners = new Set<() => void>();

function setPreference(next: ThemePreference) {
  if (next === currentPreference) return;
  currentPreference = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  applyTheme(next);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return currentPreference;
}

export function useThemePreference() {
  const preference = useSyncExternalStore(subscribe, getSnapshot);
  return {
    preference,
    isDark: preference === "dark",
    setTheme: setPreference,
  };
}
