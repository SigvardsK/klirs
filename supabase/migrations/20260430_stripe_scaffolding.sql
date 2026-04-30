-- Sprint 2 T2 — SKU-independent Stripe scaffolding
-- Source: STRIPE-REUSE-PLAN.md §"Schema deltas" + FSV2 reference (Drizzle schema lines 21-27)
-- SKU-dependent columns (plan, seat_count, screenings_used_this_period, screenings_quota_period,
--   period_start_at, pack_balance, retention_until) intentionally DEFERRED to Phase B B1
--   pending A12 SKU lock 2026-05-08.

-- 1. Stripe identity columns on profiles (SKU-independent — every paid org has these regardless of plan shape)
alter table profiles add column if not exists stripe_customer_id text;
alter table profiles add column if not exists subscription_id text;
alter table profiles add column if not exists subscription_status text;  -- mirrors Stripe values: 'active' | 'trialing' | 'canceled' | 'past_due' | 'unpaid' | 'incomplete'
alter table profiles add column if not exists subscription_expires_at timestamptz;
alter table profiles add column if not exists last_stripe_sync timestamptz;

-- 2. Webhook idempotency table (DEBT-07 from FSV2 audit)
-- Service-role-only writes (webhook handler uses SUPABASE_SERVICE_KEY).
-- L2 of two-tier idempotency; L1 is an in-memory Set in the handler process.
create table if not exists processed_stripe_events (
  event_id text primary key,                    -- Stripe event ID (e.g. "evt_1Abc...")
  type text not null,                           -- e.g. 'invoice.paid', 'customer.subscription.updated'
  processed_at timestamptz default now() not null,
  payload jsonb                                 -- full event payload for forensic / replay
);

create index if not exists idx_processed_stripe_events_processed_at
  on processed_stripe_events (processed_at);   -- supports DEBT-07 6-hour cleanup query

-- RLS: service-role-only. No user-side reads or writes.
alter table processed_stripe_events enable row level security;

-- No policies created → all anon/authenticated access denied.
-- Only the service-role key (used by the webhook handler) bypasses RLS.

comment on table processed_stripe_events is
  'Two-tier idempotency L2 store. Webhook handler MUST check this before processing any Stripe event. Cleanup: events older than 7 days dropped via scheduled job (cf. FSV2 cleanupOldEvents).';
