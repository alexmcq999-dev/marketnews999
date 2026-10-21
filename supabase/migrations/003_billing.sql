-- McQ Pro: оплата. Выполнить один раз в Supabase → SQL Editor (после 002).
-- Платежи пишет только функция billing (service role). Клиент видит лишь свои платежи.

create table if not exists public.payments (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,              -- stars | cryptopay
  ext_id text not null,                -- telegram_payment_charge_id / id счёта Crypto Pay
  amount numeric not null,
  asset text not null,                 -- XTR | USDT | …
  days int not null,
  until timestamptz,                   -- до какого числа стала подписка после этого платежа
  refunded boolean not null default false,
  raw jsonb,
  created_at timestamptz not null default now(),
  unique (provider, ext_id)
);
alter table public.payments enable row level security;
drop policy if exists "own payments read" on public.payments;
create policy "own payments read" on public.payments for select using (auth.uid() = user_id);

-- Зачесть платёж: +p_days к подписке (от текущей даты окончания, если она ещё в будущем).
-- Повторный вызов с тем же платежом ничего не меняет (вебхуки могут прийти дважды).
create or replace function public.billing_record(p_user uuid, p_provider text, p_ext text, p_amount numeric,
                                                 p_asset text, p_days int, p_raw jsonb)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare n int; cur public.subscriptions%rowtype; v timestamptz;
begin
  insert into payments (user_id, provider, ext_id, amount, asset, days, raw)
  values (p_user, p_provider, p_ext, p_amount, p_asset, p_days, p_raw)
  on conflict (provider, ext_id) do nothing;
  get diagnostics n = row_count;
  select * into cur from subscriptions where user_id = p_user for update;
  if n = 0 then return cur.until; end if;                                  -- уже зачтён
  if found and cur.plan = 'pro' and cur.until is null then return null; end if;   -- бессрочная (выдана вручную)
  v := greatest(coalesce(cur.until, now()), now()) + make_interval(days => p_days);
  insert into subscriptions (user_id, plan, until, source) values (p_user, 'pro', v, p_provider)
  on conflict (user_id) do update set plan = 'pro', until = excluded.until, source = excluded.source;
  update payments set until = v where provider = p_provider and ext_id = p_ext;
  return v;
end $$;
revoke execute on function public.billing_record(uuid, text, text, numeric, text, int, jsonb) from public, anon, authenticated;

-- Возврат платежа: снимаем оплаченные дни.
create or replace function public.billing_refund(p_provider text, p_ext text)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare p public.payments%rowtype; v timestamptz;
begin
  select * into p from payments where provider = p_provider and ext_id = p_ext for update;
  if not found or p.refunded then return null; end if;
  update payments set refunded = true where id = p.id;
  update subscriptions set until = until - make_interval(days => p.days)
   where user_id = p.user_id and until is not null
  returning until into v;
  return v;
end $$;
revoke execute on function public.billing_refund(text, text) from public, anon, authenticated;

-- Пробный период: один раз на аккаунт и один раз на Telegram-аккаунт (чтобы не брать пробный заново через другой вход).
create table if not exists public.trials (
  user_id uuid primary key references auth.users (id) on delete cascade,
  tg_id text unique,
  started_at timestamptz not null default now(),
  ends_at timestamptz not null
);
alter table public.trials enable row level security;
drop policy if exists "own trial read" on public.trials;
create policy "own trial read" on public.trials for select using (auth.uid() = user_id);

-- Начать пробный период. Возвращает дату окончания или ошибку: trial_used / already_pro.
create or replace function public.start_trial(p_user uuid, p_tg text, p_days int)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare cur public.subscriptions%rowtype; v timestamptz;
begin
  if exists (select 1 from trials where user_id = p_user or (p_tg is not null and tg_id = p_tg)) then
    raise exception 'trial_used';
  end if;
  select * into cur from subscriptions where user_id = p_user for update;
  if found and cur.plan = 'pro' and (cur.until is null or cur.until > now()) then
    raise exception 'already_pro';
  end if;
  if exists (select 1 from payments where user_id = p_user) then
    raise exception 'trial_used';                       -- уже платил раньше — пробный не нужен
  end if;
  v := now() + make_interval(days => p_days);
  insert into trials (user_id, tg_id, ends_at) values (p_user, p_tg, v);
  insert into subscriptions (user_id, plan, until, source) values (p_user, 'pro', v, 'trial')
  on conflict (user_id) do update set plan = 'pro', until = excluded.until, source = 'trial';
  return v;
end $$;
revoke execute on function public.start_trial(uuid, text, int) from public, anon, authenticated;
