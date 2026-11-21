-- Откуда пришли пользователи: первый и последний источник визита (UTM, сайт-источник, start_param Telegram)
alter table public.profiles add column if not exists first_source jsonb;
alter table public.profiles add column if not exists last_source jsonb;

-- Сводка «сколько регистраций принёс каждый источник» — только для владельца (через SQL Editor), RLS не меняется
create or replace view public.signup_sources with (security_invoker = true) as
select coalesce(first_source->>'utm_source', 'unknown') as source,
       coalesce(first_source->>'utm_medium', '')        as medium,
       coalesce(first_source->>'utm_campaign', '')      as campaign,
       count(*)                                          as users,
       min(created_at)                                   as first_signup,
       max(created_at)                                   as last_signup
from public.profiles
group by 1, 2, 3
order by users desc;
revoke all on public.signup_sources from anon, authenticated;
