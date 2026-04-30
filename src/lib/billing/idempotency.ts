/**
 * Two-tier webhook idempotency for Stripe events.
 *
 *   incoming event → check L1 Set (fast, in-memory, lost on restart)
 *                  → check L2 DB (persistent, survives restarts)
 *                  → process event
 *                  → on success: write to L1 + L2
 *                  → on failure: don't write either, return 500 → Stripe retries
 *
 * L1 saves a DB round-trip on the hot path. L2 survives Railway redeploys
 * (which drop in-memory state). Without L2, every deploy re-processes the
 * last few hours of events — duplicate billing state, duplicate analytics.
 *
 * Source: FanServiceV2 server/index.ts:61-77, server/storage.ts:317-333
 *   (audit findings SEC-06 + DEBT-07). Adapted from Drizzle to Supabase
 *   service-role client.
 */
import { createAdminClient } from "@/lib/supabase/admin";

const MAX_PROCESSED_EVENTS = 10_000;
const processedEvents = new Set<string>();

/** L1 lookup. Fast path; warm cache after L2 hit. */
export function isEventProcessedL1(eventId: string): boolean {
  return processedEvents.has(eventId);
}

/** L2 lookup. Survives process restarts. */
export async function isEventProcessedL2(eventId: string): Promise<boolean> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("processed_stripe_events")
    .select("event_id")
    .eq("event_id", eventId)
    .maybeSingle();

  if (error) {
    console.error("L2 idempotency check failed:", error.message);
    // Fail closed: if we can't check L2, treat as unseen and process.
    // The L1 cache + Stripe's at-least-once delivery still de-duplicates within a process.
    return false;
  }
  return !!data;
}

/** Track in L1. FIFO eviction to bound memory. */
export function trackProcessedEventL1(eventId: string): void {
  processedEvents.add(eventId);
  if (processedEvents.size > MAX_PROCESSED_EVENTS) {
    const oldest = processedEvents.values().next().value;
    if (oldest) processedEvents.delete(oldest);
  }
}

/** Persist in L2. Idempotent (UPSERT semantics via primary key conflict). */
export async function markEventProcessedL2(
  eventId: string,
  type: string,
  payload?: unknown,
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("processed_stripe_events")
    .insert({ event_id: eventId, type, payload })
    // Stripe retries can race; ON CONFLICT DO NOTHING keeps the first write.
    .select();

  if (error && error.code !== "23505" /* unique_violation */) {
    console.error("L2 idempotency persist failed:", error.message);
    // Don't throw — L1 still active. Worst case: a redeploy could re-process
    // this event once (acceptable per FSV2 SEC-06 doc).
  }
}

/**
 * Combined check: returns true if event already processed at either tier.
 * Use this at the top of the webhook handler to short-circuit before
 * doing any work.
 */
export async function isEventAlreadyProcessed(eventId: string): Promise<boolean> {
  if (isEventProcessedL1(eventId)) return true;
  if (await isEventProcessedL2(eventId)) {
    trackProcessedEventL1(eventId); // Warm L1 for the rest of this process.
    return true;
  }
  return false;
}

/** Mark in both tiers. Call ONLY after successful event handling. */
export async function markEventProcessed(
  eventId: string,
  type: string,
  payload?: unknown,
): Promise<void> {
  trackProcessedEventL1(eventId);
  await markEventProcessedL2(eventId, type, payload);
}

/**
 * Cleanup helper for old L2 events. Call from a scheduled function
 * (Supabase scheduled function or Vercel Cron) every 6h.
 *
 * Source: FSV2 storage.ts:328-333 (DEBT-07).
 */
export async function cleanupOldProcessedEvents(daysOld = 7): Promise<number> {
  const supabase = createAdminClient();
  const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  const { error, count } = await supabase
    .from("processed_stripe_events")
    .delete({ count: "exact" })
    .lt("processed_at", cutoff.toISOString());
  if (error) {
    console.error("cleanupOldProcessedEvents failed:", error.message);
    return 0;
  }
  return count ?? 0;
}
