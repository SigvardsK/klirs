"use client";

import { ThemeProvider as NextThemesProvider, type ThemeProviderProps } from "next-themes";

/**
 * Wraps next-themes ThemeProvider so it can be mounted from a server-component
 * root layout. Defaults configured in <RootLayout>: light theme on landing,
 * persisted via localStorage, no `prefers-color-scheme` auto-detect (legal /
 * accounting audience is light-first by intent, not OS preference).
 *
 * Dashboard subtree forces `.dark` via a wrapping <div className="dark"> in
 * `src/app/(dashboard)/layout.tsx` — that hard-overrides the theme provider's
 * choice for any semantic-token component rendered under the dashboard, so
 * power-user surfaces stay dark regardless of landing toggle state.
 */
export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
