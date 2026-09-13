"use client";

import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "@phosphor-icons/react";
import { useTheme } from "next-themes";

const ORDER = ["system", "light", "dark"] as const;

type ThemeName = (typeof ORDER)[number];

const LABELS: Record<ThemeName, string> = {
  system: "System theme",
  light: "Light theme",
  dark: "Dark theme",
};

function normalize(theme: string | undefined): ThemeName {
  return theme === "light" || theme === "dark" ? theme : "system";
}

const emptySubscribe = () => () => {};

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  // Hydration-safe mounted guard: false during SSR/hydration, true after.
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );

  const current = normalize(theme);
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      className="focus-ring inline-flex size-8 items-center justify-center rounded-[var(--radius-sm)] border border-hairline text-mute transition-colors hover:bg-canvas-soft hover:text-ink"
      aria-label={
        mounted ? `${LABELS[current]} — switch to ${LABELS[next].toLowerCase()}` : "Theme"
      }
      title={mounted ? LABELS[current] : undefined}
    >
      {/* mounted guard: the resolved theme is unknown on the server — render a
          stable placeholder until after hydration to avoid a flash/mismatch */}
      {!mounted ? (
        <span aria-hidden className="size-4" />
      ) : current === "system" ? (
        <Monitor size={16} weight="regular" aria-hidden />
      ) : current === "light" ? (
        <Sun size={16} weight="regular" aria-hidden />
      ) : (
        <Moon size={16} weight="regular" aria-hidden />
      )}
    </button>
  );
}
