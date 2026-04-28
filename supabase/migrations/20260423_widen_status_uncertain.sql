-- Widen screening_checks.status CHECK constraint to allow 'uncertain'.
--
-- The engine's tri-state classifier emits 'uncertain' when a sanctions/PEP search page
-- does NOT return its confirmed no-match indicator — a state an earlier prototype
-- silently collapsed to 'clear', producing false-negatives on sanctioned entities.
-- The old CHECK constraint would reject the new writes; this migration widens it and
-- is safe to run against an existing schema (reversible, no data rewrite).
--
-- Run in the Supabase SQL editor or:
--   supabase db push --linked --dns-resolver https
-- (or, ad-hoc)
--   supabase db query --linked --dns-resolver https --file supabase/migrations/20260423_widen_status_uncertain.sql

alter table screening_checks
  drop constraint if exists screening_checks_status_check;

alter table screening_checks
  add constraint screening_checks_status_check
  check (status in ('pending', 'clear', 'hit', 'uncertain', 'error'));
