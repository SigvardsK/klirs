-- AML Screening Portal Schema

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- Profiles (extends auth.users)
create table profiles (
  id uuid references auth.users on delete cascade primary key,
  full_name text,
  email text,
  organization text,
  created_at timestamptz default now()
);

-- Auto-create profile on user signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'name',
      split_part(new.email, '@', 1)
    ),
    new.email
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Screenings
create table screenings (
  id uuid primary key default gen_random_uuid(),
  created_by uuid references profiles(id) on delete cascade,
  entity_name text not null,
  entity_type text not null check (entity_type in ('company', 'individual')),
  jurisdiction text not null default 'LV',
  registration_number text,
  persons jsonb default '[]',
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'completed', 'failed')),
  checks_total integer default 0,
  checks_completed integer default 0,
  is_demo boolean default false,
  created_at timestamptz default now(),
  completed_at timestamptz
);

-- Screening checks (individual database results)
create table screening_checks (
  id uuid primary key default gen_random_uuid(),
  screening_id uuid references screenings(id) on delete cascade,
  database_name text not null,
  category text not null,
  search_term text not null,
  status text not null default 'pending' check (status in ('pending', 'clear', 'hit', 'uncertain', 'error')),
  screenshot_path text,
  details text,
  checked_at timestamptz
);

-- Row Level Security
alter table profiles enable row level security;
alter table screenings enable row level security;
alter table screening_checks enable row level security;

-- Profiles: users can read/update their own profile
create policy "Users can view own profile"
  on profiles for select using (auth.uid() = id);
create policy "Users can update own profile"
  on profiles for update using (auth.uid() = id);

-- Screenings: users can CRUD their own screenings
create policy "Users can view own screenings"
  on screenings for select using (auth.uid() = created_by);
create policy "Users can create screenings"
  on screenings for insert with check (auth.uid() = created_by);
create policy "Users can update own screenings"
  on screenings for update using (auth.uid() = created_by);

-- Screening checks: users can view checks for their screenings
create policy "Users can view own screening checks"
  on screening_checks for select
  using (
    exists (
      select 1 from screenings
      where screenings.id = screening_checks.screening_id
      and screenings.created_by = auth.uid()
    )
  );

-- Service role bypasses RLS for screening engine writes
-- (uses SUPABASE_SERVICE_KEY, not anon key)

-- Storage bucket for evidence screenshots
-- Run manually in Supabase dashboard:
-- insert into storage.buckets (id, name, public) values ('evidence-screenshots', 'evidence-screenshots', true);

-- Indexes
create index idx_screenings_created_by on screenings(created_by);
create index idx_screening_checks_screening_id on screening_checks(screening_id);
