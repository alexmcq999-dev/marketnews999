-- McQ Pro: подписка, лимиты ИИ-ассистента и лист ожидания. Выполнить один раз в Supabase → SQL Editor (после 001).

-- Подписка. Писать сюда может только админ/сервер (service role) — у клиентов есть лишь чтение своей строки.
create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan text not null default 'pro',
  until timestamptz,                -- null = бессрочно
  source text,                      -- manual / stars / stripe …
  created_at timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
drop policy if exists "own subscription read" on public.subscriptions;
create policy "own subscription read" on public.subscriptions for select using (auth.uid() = user_id);

-- Сколько вопросов ИИ задано за день (считает функция chart-ai)
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null default current_date,
  n int not null default 0,
  primary key (user_id, day)
);
alter table public.ai_usage enable row level security;
drop policy if exists "own usage read" on public.ai_usage;
create policy "own usage read" on public.ai_usage for select using (auth.uid() = user_id);

-- Заявки «Хочу McQ Pro»
create table if not exists public.pro_waitlist (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.pro_waitlist enable row level security;
drop policy if exists "join waitlist" on public.pro_waitlist;
drop policy if exists "own waitlist read" on public.pro_waitlist;
drop policy if exists "own waitlist update" on public.pro_waitlist;
create policy "join waitlist" on public.pro_waitlist for insert with check (auth.uid() = user_id);
create policy "own waitlist read" on public.pro_waitlist for select using (auth.uid() = user_id);
create policy "own waitlist update" on public.pro_waitlist for update using (auth.uid() = user_id);

-- Атомарный счётчик вопросов: возвращает номер вопроса за сегодня или -1, если лимит исчерпан
create or replace function public.bump_ai_usage(p_user uuid, p_limit int) returns int
language plpgsql security definer set search_path = public as $$
declare v int;
begin
  insert into ai_usage (user_id, day, n) values (p_user, current_date, 1)
  on conflict (user_id, day) do update set n = ai_usage.n + 1
  returning n into v;
  if v > p_limit then
    update ai_usage set n = n - 1 where user_id = p_user and day = current_date;
    return -1;
  end if;
  return v;
end $$;
revoke execute on function public.bump_ai_usage(uuid, int) from public, anon, authenticated;

-- Выдать подписку вручную (id пользователя — Authentication → Users):
--   insert into public.subscriptions (user_id, plan, until, source)
--   values ('<uuid>', 'pro', now() + interval '30 days', 'manual')
--   on conflict (user_id) do update set plan = excluded.plan, until = excluded.until, source = excluded.source;
