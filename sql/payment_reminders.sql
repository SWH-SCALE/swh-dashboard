-- =====================================================================
-- SWH Payment Reminders: database setup
-- =====================================================================
-- Run once in Supabase: SQL Editor > New query > paste > Run.
-- Safe to run more than once.
--
-- ADDITIVE ONLY. Existing tables, views and data are not changed, except
-- for ONE new nullable column on retainer_installments (amount_paid_usd)
-- so the Retainers tab can show partial payments.
--
-- Every new table has Row Level Security ON with no policies, so the
-- public key used by the browser cannot read or write them. Only the
-- server (service role key, stored in Vercel) can.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. Partial-payment total on each instalment (written by the server,
--    read by the Retainers tab). Nullable, so nothing existing changes.
-- ---------------------------------------------------------------------
alter table public.retainer_installments
  add column if not exists amount_paid_usd numeric(12,2);

-- ---------------------------------------------------------------------
-- 2. Per-client reminder settings
-- ---------------------------------------------------------------------
create table if not exists public.reminder_client_settings (
  client_id       text primary key,
  auto_reminders  boolean not null default false,   -- OFF until switched on per client
  paused          boolean not null default false,
  reminder_email  text,
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3. Whop payment link per instalment
-- ---------------------------------------------------------------------
create table if not exists public.instalment_whop_links (
  instalment_id      text primary key,
  client_id          text not null,
  url                text not null,
  plan_id            text,
  verify_status      text not null default 'unverified'
                     check (verify_status in ('verified','mismatch','unverified')),
  verified_amount    numeric(12,2),
  verified_currency  text,
  verify_note        text,
  verified_at        timestamptz,
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 4. Payment ledger (append-only: rows can never be edited or deleted)
-- ---------------------------------------------------------------------
create table if not exists public.instalment_payments (
  id               uuid primary key default gen_random_uuid(),
  instalment_id    text not null,
  client_id        text not null,
  source           text not null check (source in ('whop','manual')),
  whop_payment_id  text unique,
  amount_usd       numeric(12,2) not null check (amount_usd > 0),
  currency         text not null default 'usd',
  paid_at          timestamptz not null,
  match_method     text,
  payer_email      text,
  notes            text,
  recorded_at      timestamptz not null default now()
);
create index if not exists instalment_payments_instalment_idx
  on public.instalment_payments (instalment_id);

create or replace function public.swh_append_only()
returns trigger language plpgsql as $$
begin
  raise exception '% is append-only: historical payment records cannot be changed', tg_table_name;
end $$;

drop trigger if exists instalment_payments_append_only on public.instalment_payments;
create trigger instalment_payments_append_only
  before update or delete on public.instalment_payments
  for each row execute function public.swh_append_only();

-- ---------------------------------------------------------------------
-- 5. Whop payments that could not be matched with certainty
-- ---------------------------------------------------------------------
create table if not exists public.payment_reviews (
  whop_payment_id         text primary key,
  status                  text not null default 'open'
                          check (status in ('open','applied','dismissed')),
  reason                  text,
  amount_usd              numeric(12,2),
  currency                text,
  payer_email             text,
  payer_name              text,
  plan_id                 text,
  product_id              text,
  paid_at                 timestamptz,
  created_at              timestamptz not null default now(),
  resolved_at             timestamptz,
  resolved_instalment_id  text
);

-- ---------------------------------------------------------------------
-- 6. Reminder sends. One LIVE email per instalment + due date + stage,
--    enforced by the database (unique index), so duplicate cron runs
--    can never send the same reminder twice. If a due date is moved,
--    the schedule restarts for the new date.
-- ---------------------------------------------------------------------
create table if not exists public.reminder_sends (
  id                uuid primary key default gen_random_uuid(),
  instalment_id     text not null,
  client_id         text not null,
  due_date          date not null,
  stage             text not null check (stage in ('pre3','due','over2','over5','over7')),
  mode              text not null check (mode in ('live','test')),
  status            text not null check (status in ('sending','sent','failed','uncertain','cancelled')),
  to_email          text not null,
  amount_usd        numeric(12,2),
  whop_url          text,
  subject           text,
  gmail_message_id  text,
  attempts          int not null default 1,
  last_error        text,
  created_at        timestamptz not null default now(),
  sent_at           timestamptz,
  updated_at        timestamptz not null default now()
);
create unique index if not exists reminder_sends_live_once
  on public.reminder_sends (instalment_id, due_date, stage) where mode = 'live';
create index if not exists reminder_sends_client_idx
  on public.reminder_sends (client_id, created_at desc);

-- ---------------------------------------------------------------------
-- 7. Whop webhook deliveries (duplicate deliveries are ignored)
-- ---------------------------------------------------------------------
create table if not exists public.webhook_events (
  webhook_id    text primary key,
  provider      text not null default 'whop',
  event_type    text,
  status        text not null default 'processing'
                check (status in ('processing','processed','ignored','error')),
  attempts      int not null default 1,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  error         text,
  payload       jsonb
);

-- ---------------------------------------------------------------------
-- 8. Automation activity log (sends, failures, payments, webhooks)
-- ---------------------------------------------------------------------
create table if not exists public.automation_log (
  id             bigserial primary key,
  created_at     timestamptz not null default now(),
  level          text not null default 'info' check (level in ('info','warn','error')),
  event          text not null,
  client_id      text,
  instalment_id  text,
  message        text,
  details        jsonb
);
create index if not exists automation_log_created_idx on public.automation_log (created_at desc);
create index if not exists automation_log_client_idx  on public.automation_log (client_id, created_at desc);

-- ---------------------------------------------------------------------
-- 9. Gmail connection (single row). The refresh token is stored
--    ENCRYPTED with a key that only exists in Vercel.
-- ---------------------------------------------------------------------
create table if not exists public.gmail_connection (
  id                 int primary key default 1 check (id = 1),
  email              text,
  refresh_token_enc  text,
  scope              text,
  status             text not null default 'disconnected'
                     check (status in ('connected','disconnected','error')),
  connected_at       timestamptz,
  last_used_at       timestamptz,
  last_error         text,
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 10. Job lock so two overlapping reminder runs cannot both send
-- ---------------------------------------------------------------------
create table if not exists public.job_locks (
  name          text primary key,
  holder        text not null,
  locked_until  timestamptz not null
);

create or replace function public.claim_job_lock(p_name text, p_holder text, p_seconds int)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  insert into public.job_locks (name, holder, locked_until)
  values (p_name, p_holder, now() + make_interval(secs => p_seconds))
  on conflict (name) do update
    set holder = excluded.holder, locked_until = excluded.locked_until
    where public.job_locks.locked_until < now();
  return found;
end $$;

create or replace function public.release_job_lock(p_name text, p_holder text)
returns void language sql security definer set search_path = public as $$
  delete from public.job_locks where name = p_name and holder = p_holder;
$$;

-- ---------------------------------------------------------------------
-- 11. Lock everything down: server only
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'reminder_client_settings','instalment_whop_links','instalment_payments',
    'payment_reviews','reminder_sends','webhook_events','automation_log',
    'gmail_connection','job_locks'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on table public.%I from authenticated', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant all on table public.%I to service_role', t);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage, select on sequence public.automation_log_id_seq to service_role;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on sequence public.automation_log_id_seq from anon;
  end if;
end $$;

revoke all on function public.claim_job_lock(text, text, int) from public;
revoke all on function public.release_job_lock(text, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.claim_job_lock(text, text, int) to service_role;
    grant execute on function public.release_job_lock(text, text) to service_role;
  end if;
end $$;

-- Done. Check: select count(*) from public.reminder_sends;  -- should return 0
