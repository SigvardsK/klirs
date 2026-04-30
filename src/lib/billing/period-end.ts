/**
 * Extract current_period_end from a Stripe Subscription.
 *
 * In Stripe SDK v18+ (API version 2025-04-30.basil and later), the field
 * moved from the top-level Subscription object to SubscriptionItem. This
 * helper reads the new location first and falls back for older API
 * versions / runtime data shapes.
 *
 * Source: FanServiceV2 server/index.ts:84-95 (SDK v18 quirk).
 */
export function getSubscriptionPeriodEnd(
  subscription: Record<string, unknown>,
): Date | null {
  const items = subscription.items as
    | { data?: Array<{ current_period_end?: number }> }
    | undefined;
  const itemEnd = items?.data?.[0]?.current_period_end;
  if (typeof itemEnd === "number") {
    return new Date(itemEnd * 1000);
  }
  const topLevelEnd = subscription.current_period_end;
  if (typeof topLevelEnd === "number") {
    return new Date(topLevelEnd * 1000);
  }
  return null;
}
