-- Stuck-state probe for auth_pkce_state (LR-WS-2026-038).
--
-- Background: auth_pkce_state rows are created on OAuth init (10-min TTL)
-- and deleted on callback (success or failure). When users abandon mid-flow
-- (close tab, network drop, expired Google session), no callback ever runs
-- and the row sits forever. Original 20260504 migration explicitly deferred
-- cleanup to a future pg_cron job — that probe was never shipped, exactly
-- the LR-WS-2026-038 anti-pattern.
--
-- Approach: opportunistic GC on every insert. Each new OAuth init also
-- sweeps any expired rows. Cheap (table is small + indexed on expires_at),
-- self-contained (no scheduler infra), and the work is amortized across
-- normal traffic. Statement-level trigger so the sweep runs once per
-- INSERT statement, not per row inserted.
--
-- Trade-off: if no one signs in for an extended period, expired rows
-- linger until someone does. Acceptable — table is bounded by 10-min TTL
-- × concurrent OAuth attempts, ~tens of rows worst case. If volume scales
-- past that, replace with pg_cron.

create or replace function public.gc_auth_pkce_state()
returns trigger
language plpgsql
security definer
as $$
begin
  delete from public.auth_pkce_state where expires_at < now();
  return null;
end;
$$;

drop trigger if exists gc_auth_pkce_state_on_insert on public.auth_pkce_state;
create trigger gc_auth_pkce_state_on_insert
  after insert on public.auth_pkce_state
  for each statement execute procedure public.gc_auth_pkce_state();
