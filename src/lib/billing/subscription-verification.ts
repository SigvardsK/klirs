/**
 * Stripe subscription verification — sync DB state with Stripe API truth.
 *
 * Uses: (a) inside webhook handlers as the SEC-06 re-fetch pattern (don't
 * trust the event payload — re-retrieve and verify), (b) periodically as a
 * drift-correction job (every 6h) for orgs whose Stripe data may be stale.
 *
 * Source: FanServiceV2 server/subscription-verification.ts (full file).
 * Adaptations:
 *   - FSV2 reads/writes via Drizzle `users` table → Klirs reads/writes via
 *     Supabase service-role client against `profiles`.
 *   - FSV2 has a boolean `isPremium` field; Klirs uses `subscription_status`
 *     directly (the SKU-dependent `plan` enum is deferred to Phase B B1).
 *   - FSV2's `verifyAllSubscriptions` pulled "users needing sync" via a
 *     Drizzle query; Klirs equivalent is a `select … where last_stripe_sync
 *     is null or last_stripe_sync < now() - interval '6 hours'`.
 */
import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSubscriptionPeriodEnd } from "./period-end";

if (!process.env.KLIRS_STRIPE_SECRET_KEY) {
  // Don't throw at import time in dev — only when an actual call is made.
  // Phase B B1 wiring will add a runtime check on webhook entry.
}

function getStripeClient(): Stripe {
  const key = process.env.KLIRS_STRIPE_SECRET_KEY;
  if (!key) throw new Error("Missing KLIRS_STRIPE_SECRET_KEY");
  return new Stripe(key, { apiVersion: "2025-04-30.basil" as Stripe.LatestApiVersion });
}

/**
 * Returns true if the Stripe subscription status represents an active
 * subscription. Covers 'active' (normal billing) and 'trialing' (free-trial
 * period). Audit guard C2 — must include 'trialing' or trial users get
 * locked out.
 */
export function isActiveSubscriptionStatus(status: string): boolean {
  return status === "active" || status === "trialing";
}

/**
 * Verify a single profile's subscription status with Stripe API.
 * Updates the profile row with the latest Stripe truth.
 */
export async function verifyProfileSubscription(profileId: string): Promise<void> {
  const supabase = createAdminClient();
  const { data: profile, error: fetchError } = await supabase
    .from("profiles")
    .select("id, stripe_customer_id, subscription_id, subscription_status, subscription_expires_at")
    .eq("id", profileId)
    .maybeSingle();

  if (fetchError || !profile) {
    console.error("verifyProfileSubscription: profile fetch failed:", fetchError?.message);
    return;
  }
  if (!profile.stripe_customer_id || !profile.subscription_id) {
    return; // Nothing to verify — this profile has no Stripe link yet.
  }

  const stripe = getStripeClient();
  try {
    const subscription = await stripe.subscriptions.retrieve(profile.subscription_id);
    const expiresAt = getSubscriptionPeriodEnd(
      subscription as unknown as Record<string, unknown>,
    );

    const driftedStatus = profile.subscription_status !== subscription.status;
    const driftedExpiry =
      !profile.subscription_expires_at ||
      !expiresAt ||
      Math.abs(
        new Date(profile.subscription_expires_at).getTime() - expiresAt.getTime(),
      ) > 60_000; // 1-minute tolerance

    await supabase
      .from("profiles")
      .update({
        subscription_status: subscription.status,
        subscription_expires_at: expiresAt?.toISOString() ?? null,
        last_stripe_sync: new Date().toISOString(),
      })
      .eq("id", profile.id);

    if (driftedStatus || driftedExpiry) {
      // No-op log point — Phase B B1 may add structured drift logging here.
    }
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError && error.code === "resource_missing") {
      // Subscription deleted upstream — mark canceled, don't crash.
      await supabase
        .from("profiles")
        .update({
          subscription_status: "canceled",
          last_stripe_sync: new Date().toISOString(),
        })
        .eq("id", profile.id);
      return;
    }
    console.error(
      "verifyProfileSubscription: Stripe error:",
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Drift-correction sweep: find profiles whose Stripe sync is stale (>6h or
 * never synced) and re-verify each. Throttled in batches of 5 with a 1s
 * gap between batches to respect Stripe's API rate ceiling.
 *
 * Wire to a Vercel Cron / Supabase scheduled function in Phase B B1.
 */
export async function verifyAllStaleSubscriptions(): Promise<void> {
  const supabase = createAdminClient();
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("id")
    .not("subscription_id", "is", null)
    .or(`last_stripe_sync.is.null,last_stripe_sync.lt.${sixHoursAgo}`);

  if (error || !profiles) {
    console.error("verifyAllStaleSubscriptions: profile query failed:", error?.message);
    return;
  }

  const batchSize = 5;
  for (let i = 0; i < profiles.length; i += batchSize) {
    const batch = profiles.slice(i, i + batchSize);
    await Promise.all(batch.map((p) => verifyProfileSubscription(p.id)));
    if (i + batchSize < profiles.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
