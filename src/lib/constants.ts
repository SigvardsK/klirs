// Superusers bypass the freemium gate (3-screening demo limit) and produce non-demo
// screenings (no PARAUGS watermark on annexes, full audit PDF export enabled).
// Configured via SUPERUSER_EMAILS env var as a comma-separated list, e.g.
//   SUPERUSER_EMAILS=alice@example.com,bob@example.com
// Empty by default — every signup is freemium-gated.
//
// Stored lowercased + trimmed so the check is case-insensitive (Google OAuth
// can return emails with non-canonical casing; matching `Sigvards@…` against
// `sigvards@…` would otherwise silently break the bypass).
export const SUPERUSERS: string[] = (process.env.SUPERUSER_EMAILS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/** Case-insensitive superuser check. Use this instead of SUPERUSERS.includes(...). */
export function isSuperuserEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return SUPERUSERS.includes(email.trim().toLowerCase());
}

// Freemium demo gate — single source of truth referenced by:
//   - src/app/(dashboard)/dashboard/page.tsx (gate wall + disabled button)
//   - src/app/(dashboard)/screenings/new/screening-form.tsx (submit-time guard)
export const DEMO_LIMIT = 3;
export const DEMO_LIMIT_SENTINEL = "__DEMO_LIMIT_REACHED__";
export const DEMO_CONTACT_HREF =
  "mailto:sigvards@krongorns.com?subject=Klirs%20pilot%20%E2%80%94%20more%20screenings";
