// Superusers bypass the freemium gate (1-screening demo limit) and produce non-demo
// screenings (no PARAUGS watermark on annexes, full audit PDF export enabled).
// Configured via SUPERUSER_EMAILS env var as a comma-separated list, e.g.
//   SUPERUSER_EMAILS=alice@example.com,bob@example.com
// Empty by default — every signup is freemium-gated.
export const SUPERUSERS: string[] = (process.env.SUPERUSER_EMAILS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
