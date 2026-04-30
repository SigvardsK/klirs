/**
 * Server-controlled base URL for Stripe success/cancel redirects.
 *
 * MUST never trust client-provided headers (Origin, Host, Referer) when
 * constructing Stripe redirect URLs — those are forgeable and would let an
 * attacker redirect successful payments through their own intercepting domain.
 *
 * Source: FanServiceV2 server/routes.ts:17-24 (audit guard H3).
 * Adapted: FSV2 read APP_BASE_URL; Klirs uses KLIRS_APP_BASE_URL to keep
 * env namespaces separate per STRIPE-REUSE-PLAN §"Same account, separate products."
 */
export function getAppBaseUrl(): string {
  if (process.env.KLIRS_APP_BASE_URL) return process.env.KLIRS_APP_BASE_URL;
  if (process.env.NODE_ENV === "production") {
    throw new Error("KLIRS_APP_BASE_URL must be set in production");
  }
  return "http://localhost:3000";
}
