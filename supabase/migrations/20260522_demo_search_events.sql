-- demo_search_events: durable, anonymized funnel telemetry for unauth /demo trials.
--
-- Why this exists: the GC trigger in 20260508_demo_trial_runs.sql deletes
-- demo_trial_runs AND demo screenings older than 24h, so the search->signup
-- funnel (who searched, did they convert?) is destroyed every 24h and cannot
-- be reconstructed historically. This table is the durable record that
-- survives the GC sweep, written one row per ACCEPTED anonymous run.
--
-- Privacy contract: NO PII. We store only a first-party opaque cookie
-- (`anon_id`, a uuid v4 minted server-side and set as klirs_anon), the entity
-- type, and a coarse locale. No IP (not even hashed — that lives in
-- demo_trial_runs), no subject name, no screening verdict. Conversion is
-- measured by joining anon_id to profiles.anon_id (populated at signup).
--
-- Retention: DELIBERATELY no GC trigger. This is the durable funnel record —
-- it must outlive the 24h sweep that clears demo_trial_runs. Bounded growth:
-- ~150 trials/month at MVP scale; trivial. Revisit only past ~10k rows/day.
create table if not exists demo_search_events (
  id uuid primary key default gen_random_uuid(),
  anon_id text not null,               -- first-party opaque cookie (klirs_anon), NOT PII
  entity_type text not null,           -- 'individual' | 'company'
  locale text,                         -- 'en' | 'lv' | null (best-effort)
  created_at timestamptz not null default now()
);

create index if not exists idx_demo_search_events_anon
  on demo_search_events(anon_id);
create index if not exists idx_demo_search_events_created
  on demo_search_events(created_at desc);

-- Service-key only — written by /api/demo/run via the service client; never
-- read by an unauthenticated client. No public RLS policy.
alter table demo_search_events enable row level security;

-- Signup attribution: nullable opaque cookie carried from the anonymous demo
-- session into the profile created at signup. Lets us join
-- demo_search_events.anon_id = profiles.anon_id to compute search->signup
-- conversion. Nullable: existing profiles and any signup without a prior demo
-- cookie simply have null. We never overwrite a non-null anon_id with null.
alter table profiles add column if not exists anon_id text;
create index if not exists idx_profiles_anon on profiles(anon_id);
