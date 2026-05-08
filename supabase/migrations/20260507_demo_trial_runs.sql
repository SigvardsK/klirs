-- demo_trial_runs: IP-hashed rate-limit ledger for unauth /demo trials.
-- Pairs with src/lib/rate-limit.ts. Raw IPs never enter the DB — we store
-- sha256(ip + DEMO_RATE_LIMIT_PEPPER) so an attacker with read access can't
-- reverse the visitor's IP.
--
-- Retention: 24h window matters for rate-limit counts; rows older than that
-- can be GC'd. The companion stuck-state probe (LR-WS-2026-038) for /demo
-- is enforced server-side via "select count(*) where created_at > now() - 24h"
-- — older rows are inert from a rate-limit standpoint, but accumulate in DB.
-- The opportunistic GC trigger below sweeps both this table AND any stale
-- demo screenings (is_demo=true rows past 24h), amortizing cleanup across
-- normal traffic. Same pattern as 20260507_auth_pkce_state_gc.sql.
create table if not exists demo_trial_runs (
  id uuid primary key default gen_random_uuid(),
  ip_hash text not null,
  screening_id uuid references screenings(id) on delete set null,
  subject_name text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_demo_trial_runs_ip_window
  on demo_trial_runs(ip_hash, created_at desc);

-- Service-key only — public access goes through /api/demo/* with explicit
-- query filters. No public RLS policy here.
alter table demo_trial_runs enable row level security;

-- GC: ships same-commit as the table per LR-WS-2026-038. Each new trial
-- run sweeps:
--   1. demo_trial_runs rows older than 24h (inert from rate-limit view)
--   2. screenings rows where is_demo=true AND older than 24h (and via
--      ON DELETE CASCADE, all their screening_checks)
--
-- Trade-off: low-traffic days mean stale rows linger until the next visitor
-- arrives. Acceptable — DB pressure is bounded by 5 runs/IP × distinct IPs/24h.
-- If trial volume scales past ~10k/day, replace with pg_cron.
--
-- NOT cleaned up here: storage objects in `evidence-screenshots/` for the
-- deleted demo screenings. Supabase Storage uses its own retention; orphaned
-- files are tolerable for MVP scale and can be swept by a separate Storage-
-- side rule later. (Cost: ~1 MB/screening × ~150 trials/month = trivial.)
create or replace function public.gc_demo_trial_runs()
returns trigger
language plpgsql
security definer
as $$
begin
  delete from public.demo_trial_runs
    where created_at < now() - interval '24 hours';
  delete from public.screenings
    where is_demo = true
      and created_at < now() - interval '24 hours';
  return null;
end;
$$;

drop trigger if exists gc_demo_trial_runs_on_insert on public.demo_trial_runs;
create trigger gc_demo_trial_runs_on_insert
  after insert on public.demo_trial_runs
  for each statement execute procedure public.gc_demo_trial_runs();
