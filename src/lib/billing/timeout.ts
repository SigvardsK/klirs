/**
 * withTimeout — race a promise against a timer.
 *
 * Used to wrap Stripe API calls inside webhook handlers. If Stripe stalls,
 * the webhook returns 500 fast → Stripe retries delivery → idempotency table
 * catches the retry. Without this, a stalled call wedges the handler past
 * Stripe's ~30s delivery timeout, leaving the process inconsistent.
 *
 * Source: FanServiceV2 server/index.ts:99-106 (DEBT-06).
 * Ported verbatim — pure function, no dependencies on Express or Next.js.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/**
 * Default timeout for Stripe webhook-internal API calls.
 * Stripe times out webhook delivery at ~30s; we use 10s to leave headroom
 * for our own DB writes, signature verification, and the retry round-trip.
 */
export const WEBHOOK_TIMEOUT_MS = 10_000;
