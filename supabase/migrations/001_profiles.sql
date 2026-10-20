-- Профили пользователей McQCryptoNews: выполнить один раз в Supabase → SQL Editor
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  provider text,
  tg_id text,
  name text,
  username text,
  avatar_url text,
  lang text,
  mode text,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists "own profile read" on public.profiles;
drop policy if exists "own profile write" on public.profiles;
drop policy if exists "own profile update" on public.profiles;
create policy "own profile read" on public.profiles for select using (auth.uid() = id);
create policy "own profile write" on public.profiles for insert with check (auth.uid() = id);
create policy "own profile update" on public.profiles for update using (auth.uid() = id);
