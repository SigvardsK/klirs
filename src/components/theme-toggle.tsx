"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

interface Props {
  toLightLabel: string;
  toDarkLabel: string;
}

/**
 * Theme toggle for landing + result pages. Light-first audience; toggle exists
 * for dark-leaning visitors and persists via next-themes localStorage.
 *
 * Renders a placeholder on first SSR pass (matches the slot dimensions) then
 * hydrates with the real icon — avoids the hydration mismatch + icon flash
 * that's the canonical next-themes gotcha.
 */
export function ThemeToggle({ toLightLabel, toDarkLabel }: Props) {
  const [mounted, setMounted] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();

  // Canonical next-themes SSR-safety pattern: render a hidden placeholder
  // during SSR + the first client paint (when localStorage isn't read yet),
  // then swap to the real icon once we know the resolved theme. The
  // setMounted(true) here is the documented hydration gate, not a cascading
  // render — fires once, never again.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <button
        type="button"
        aria-hidden="true"
        className="inline-flex items-center justify-center w-9 h-9 rounded-md border border-border bg-card opacity-0"
      >
        <Sun className="w-4 h-4" />
      </button>
    );
  }

  const isDark = resolvedTheme === "dark";
  const next = isDark ? "light" : "dark";
  const label = isDark ? toLightLabel : toDarkLabel;

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => setTheme(next)}
      className="inline-flex items-center justify-center w-9 h-9 rounded-md border border-border bg-card hover:bg-muted text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
    </button>
  );
}
