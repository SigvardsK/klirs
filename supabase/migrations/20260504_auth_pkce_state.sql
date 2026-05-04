-- Server-managed PKCE state for Brave / privacy-aggressive browser compatibility.
--
-- Why: Brave Shields (and Firefox-strict-tracking-protection, etc.) classify the
-- pattern "Set-Cookie + Location to different origin" as bounce-tracking and
-- silently drop the cookie. Our previous PKCE implementation stored the code
-- verifier in a cookie set by /auth/sign-in/google → 303 → supabase.co — exactly
-- this pattern. Result: verifier never lands in browser storage; callback
-- surfaces "PKCE code verifier not found in storage."
--
-- Fix: store the verifier server-side in this table keyed by a state token.
-- Pass the state token through the OAuth URL (Supabase forwards it back). On
-- callback, look up the verifier by state, manually exchange code+verifier with
-- Supabase's /auth/v1/token endpoint, then write session cookies via setSession.
-- The auth init response no longer needs to set any cookie, so Brave Shields
-- has nothing to block.
--
-- Rows are short-lived: the state token is valid for ~10 minutes (enough for
-- a slow OAuth round-trip), then GC'd.

create table if not exists public.auth_pkce_state (
  state text primary key,
  code_verifier text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes')
);

create index if not exists idx_auth_pkce_state_expires_at
  on public.auth_pkce_state (expires_at);

-- RLS: the table is service-role only. The auth route handlers use the admin
-- client (SUPABASE_SERVICE_KEY) for both insert and select. No anon access.
alter table public.auth_pkce_state enable row level security;

-- No policies → anon and authenticated have no access. Service role bypasses RLS.
