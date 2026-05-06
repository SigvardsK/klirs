-- Fix: allow authenticated users to upsert their own profile.
--
-- Background: profiles had `select` + `update` policies but no `insert`. The
-- post-auth upsert in /auth/callback and /auth/confirm uses the user-JWT
-- client. Postgres evaluates INSERT WITH CHECK on every `INSERT ... ON
-- CONFLICT DO UPDATE` regardless of whether the conflict path runs, so the
-- absence of an INSERT policy denied the upsert with 42501 ("new row violates
-- row-level security policy"). The handle_new_user() trigger covers
-- first-time signup, but the upsert path was always broken.

create policy "Users can insert own profile"
  on profiles for insert with check (auth.uid() = id);
