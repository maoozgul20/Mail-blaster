-- MailBlaster AI :: 0001 schema
-- Supabase PostgreSQL is the permanent source of truth. No SQLite, no Redis.
-- All primary keys are UUIDs; all tables are owned by auth.users via user_id.

------------------------------------------------------------------------------
-- helpers
------------------------------------------------------------------------------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

------------------------------------------------------------------------------
-- profiles & settings
------------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.user_settings (
  user_id                 uuid primary key references auth.users(id) on delete cascade,
  timezone                text    not null default 'UTC',
  daily_limit             int     not null default 30  check (daily_limit between 1 and 2000),
  min_interval_seconds    int     not null default 600 check (min_interval_seconds >= 0),
  max_interval_seconds    int     not null default 1200 check (max_interval_seconds >= 0),
  business_hours          jsonb   not null default '{"enabled": false, "start": "09:00", "end": "17:00"}',
  weekdays                int[]   not null default '{1,2,3,4,5,6,7}',
  track_opens             boolean not null default true,
  track_clicks            boolean not null default true,
  tracking_disclosure     text    not null default 'This email contains a tracking pixel and tracked links so the sender can see whether it was opened.',
  unsubscribe_footer      boolean not null default true,
  unsubscribe_text        text    not null default 'Don''t want to hear from me? Unsubscribe',
  signature_html          text    not null default '',
  default_followups       jsonb   not null default '[
    {"enabled": true, "delay_days": 3, "condition": "no_reply", "subject": "", "body_html": "<p>Hi {{FirstName|there}},</p><p>Just floating this to the top of your inbox in case it got buried.</p>"},
    {"enabled": true, "delay_days": 4, "condition": "no_reply", "subject": "", "body_html": "<p>Hi {{FirstName|there}},</p><p>Checking in once more - is this something you would like to explore?</p>"},
    {"enabled": true, "delay_days": 7, "condition": "no_reply", "subject": "", "body_html": "<p>Hi {{FirstName|there}},</p><p>I will close the loop on my side unless I hear back. Thanks for your time either way.</p>"}
  ]',
  notifications           jsonb   not null default '{"campaign_completed": true, "reply_received": true, "failed_sending": true, "campaign_paused": true}',
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  check (max_interval_seconds >= min_interval_seconds)
);

------------------------------------------------------------------------------
-- Gmail accounts + encrypted tokens
------------------------------------------------------------------------------
create table public.connected_accounts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  provider         text not null default 'google' check (provider = 'google'),
  email            text not null,
  display_name     text,
  status           text not null default 'active' check (status in ('active','reauth_required','disconnected','error')),
  scopes           text[] not null default '{}',
  daily_cap        int  not null default 500 check (daily_cap between 1 and 2000), -- provider hard limit, never overridden by presets
  max_concurrent   int  not null default 1 check (max_concurrent between 1 and 5),
  next_send_at     timestamptz,           -- per-account pacing gate
  blocked_until    timestamptz,           -- set after provider quota errors
  blocked_reason   text,
  last_error       text,
  last_error_at    timestamptz,
  last_reply_check_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, email)
);
create index connected_accounts_user_idx on public.connected_accounts(user_id);

-- Refresh/access tokens are AES-256-GCM encrypted by the Worker. RLS is enabled with NO policies:
-- only the service role (Worker) can ever read this table.
create table public.oauth_tokens (
  account_id         uuid primary key references public.connected_accounts(id) on delete cascade,
  refresh_token_enc  text not null,
  access_token_enc   text,
  access_expires_at  timestamptz,
  key_version        int not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

------------------------------------------------------------------------------
-- contacts
------------------------------------------------------------------------------
create table public.contacts (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  email               text not null check (email = lower(email)),
  first_name          text,
  last_name           text,
  company             text,
  website             text,
  position            text,
  custom_fields       jsonb not null default '{}',
  tags                text[] not null default '{}',
  subscription_status text not null default 'subscribed' check (subscription_status in ('subscribed','unsubscribed','cleaned')),
  consent_source      text,
  consent_at          timestamptz,
  consent_notes       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (user_id, email)
);
create index contacts_user_created_idx on public.contacts(user_id, created_at desc);
create index contacts_tags_idx on public.contacts using gin(tags);

create table public.contact_groups (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  name           text not null,
  description    text,
  is_segment     boolean not null default false,
  segment_filter jsonb not null default '{}',   -- {"tags": [...], "company": "...", "status": "..."}
  created_at     timestamptz not null default now(),
  unique (user_id, name)
);

create table public.contact_group_members (
  group_id   uuid not null references public.contact_groups(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  added_at   timestamptz not null default now(),
  primary key (group_id, contact_id)
);
create index contact_group_members_contact_idx on public.contact_group_members(contact_id);

------------------------------------------------------------------------------
-- templates
------------------------------------------------------------------------------
create table public.email_templates (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  category    text not null default 'General',
  subject     text not null default '',
  body_html   text not null default '',
  body_text   text,
  is_starter  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index email_templates_user_idx on public.email_templates(user_id, category);

------------------------------------------------------------------------------
-- campaigns
------------------------------------------------------------------------------
create table public.campaigns (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  account_id        uuid references public.connected_accounts(id) on delete set null,
  name              text not null,
  status            text not null default 'draft'
                      check (status in ('draft','scheduled','queued','running','paused','completed','cancelled','failed')),
  subject           text not null default '',
  body_html         text not null default '',
  body_text         text,
  template_id       uuid references public.email_templates(id) on delete set null,
  delivery_mode     text not null default 'send' check (delivery_mode in ('send','draft')),
  settings          jsonb not null default '{}',   -- daily_limit, intervals, timezone, business_hours, weekdays, tracking flags ...
  attachments       jsonb not null default '[]',   -- [{name, path, size, type}] stored in Supabase Storage (private bucket)
  follow_ups_enabled boolean not null default true,
  start_at          timestamptz,
  end_at            timestamptz,
  started_at        timestamptz,
  completed_at      timestamptz,
  paused_at         timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index campaigns_user_idx on public.campaigns(user_id, created_at desc);
create index campaigns_status_idx on public.campaigns(status) where status in ('scheduled','queued','running');

create table public.campaign_recipients (
  id               uuid primary key default gen_random_uuid(),
  campaign_id      uuid not null references public.campaigns(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  contact_id       uuid references public.contacts(id) on delete set null,
  email            text not null check (email = lower(email)),
  first_name       text,
  last_name        text,
  company          text,
  website          text,
  position         text,
  fields           jsonb not null default '{}',  -- custom merge fields (CustomField1, anything from the CSV)
  token            text not null unique default replace(gen_random_uuid()::text, '-', ''),
  status           text not null default 'pending'
                     check (status in ('pending','queued','sent','drafted','failed','skipped','bounced','unsubscribed')),
  sent_at          timestamptz,
  open_count       int not null default 0,
  opened_at        timestamptz,
  last_opened_at   timestamptz,
  click_count      int not null default 0,
  first_clicked_at timestamptz,
  last_clicked_at  timestamptz,
  replied_at       timestamptz,
  reply_preview    text,
  follow_ups_sent  int not null default 0,
  followups_stopped boolean not null default false,
  stop_reason      text,
  failure_reason   text,
  skip_reason      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (campaign_id, email)
);
create index campaign_recipients_campaign_status_idx on public.campaign_recipients(campaign_id, status);
create index campaign_recipients_user_email_idx on public.campaign_recipients(user_id, email);

create table public.follow_up_sequences (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null unique references public.campaigns(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now()
);

create table public.follow_up_steps (
  id               uuid primary key default gen_random_uuid(),
  sequence_id      uuid not null references public.follow_up_sequences(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  step_number      int not null check (step_number >= 1),
  enabled          boolean not null default true,
  delay_minutes    int not null check (delay_minutes >= 1),   -- relative to the previous email being submitted
  condition        text not null default 'no_reply' check (condition in ('no_reply','no_open','no_click','always')),
  subject          text not null default '',                  -- empty => "Re: <original subject>"
  body_html        text not null default '',
  body_text        text,
  reply_in_thread  boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (sequence_id, step_number)
);

------------------------------------------------------------------------------
-- queue
------------------------------------------------------------------------------
create table public.sending_jobs (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  campaign_id      uuid not null references public.campaigns(id) on delete cascade,
  recipient_id     uuid not null references public.campaign_recipients(id) on delete cascade,
  account_id       uuid references public.connected_accounts(id) on delete set null,
  step_number      int  not null default 0,        -- 0 = initial email, 1.. = follow-up stages
  status           text not null default 'queued'
                     check (status in ('queued','claimed','sending','submitted','failed','skipped','cancelled','ambiguous')),
  run_after        timestamptz not null default now(),
  attempts         int  not null default 0,
  max_attempts     int  not null default 5,
  locked_by        text,
  lease_expires_at timestamptz,
  claimed_at       timestamptz,
  completed_at     timestamptz,
  idempotency_key  text not null unique,           -- recipient_id:step  => a follow-up can never be created twice
  error_class      text,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (recipient_id, step_number)
);
create index sending_jobs_due_idx on public.sending_jobs(account_id, run_after) where status = 'queued';
create index sending_jobs_campaign_idx on public.sending_jobs(campaign_id, status);
create index sending_jobs_lease_idx on public.sending_jobs(lease_expires_at) where status in ('claimed','sending');
create index sending_jobs_account_day_idx on public.sending_jobs(account_id, claimed_at)
  where status in ('claimed','sending','submitted','ambiguous');

create table public.email_messages (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  campaign_id      uuid not null references public.campaigns(id) on delete cascade,
  recipient_id     uuid not null references public.campaign_recipients(id) on delete cascade,
  job_id           uuid not null unique references public.sending_jobs(id) on delete cascade,
  account_id       uuid references public.connected_accounts(id) on delete set null,
  step_number      int not null default 0,
  kind             text not null default 'sent' check (kind in ('sent','draft')),
  rfc_message_id   text,
  gmail_message_id text,
  gmail_thread_id  text,
  subject          text,
  to_email         text not null,
  sent_at          timestamptz not null default now()
);
create index email_messages_thread_idx on public.email_messages(account_id, gmail_thread_id);
create index email_messages_recipient_idx on public.email_messages(recipient_id, sent_at desc);

------------------------------------------------------------------------------
-- events
------------------------------------------------------------------------------
create table public.tracking_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  campaign_id   uuid not null references public.campaigns(id) on delete cascade,
  recipient_id  uuid not null references public.campaign_recipients(id) on delete cascade,
  event_type    text not null check (event_type in ('open','click')),
  url           text,
  user_agent    text,
  counted       boolean not null default true,  -- false for suspected prefetch/scanner hits (kept for transparency)
  created_at    timestamptz not null default now()
);
create index tracking_events_recipient_idx on public.tracking_events(recipient_id, created_at desc);
create index tracking_events_campaign_idx on public.tracking_events(campaign_id, event_type, created_at desc);

create table public.replies (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  campaign_id      uuid not null references public.campaigns(id) on delete cascade,
  recipient_id     uuid not null references public.campaign_recipients(id) on delete cascade,
  gmail_message_id text not null unique,
  gmail_thread_id  text,
  from_email       text,
  snippet          text,
  received_at      timestamptz not null default now(),
  created_at       timestamptz not null default now()
);
create index replies_user_idx on public.replies(user_id, received_at desc);

create table public.bounces (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  campaign_id      uuid not null references public.campaigns(id) on delete cascade,
  recipient_id     uuid not null references public.campaign_recipients(id) on delete cascade,
  bounce_type      text not null check (bounce_type in ('permanent','temporary')),
  reason           text,
  gmail_message_id text unique,
  detected_at      timestamptz not null default now()
);
create index bounces_user_idx on public.bounces(user_id, detected_at desc);

create table public.suppression_entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  email       text not null check (email = lower(email)),
  reason      text not null default 'manual' check (reason in ('unsubscribed','bounced','manual','complaint')),
  source      text,
  note        text,
  created_at  timestamptz not null default now(),
  unique (user_id, email)
);

create table public.unsubscribe_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  campaign_id   uuid references public.campaigns(id) on delete set null,
  recipient_id  uuid references public.campaign_recipients(id) on delete set null,
  email         text not null,
  method        text not null default 'link' check (method in ('link','one_click','manual')),
  user_agent    text,
  created_at    timestamptz not null default now()
);

create table public.activity_logs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  campaign_id   uuid references public.campaigns(id) on delete cascade,
  recipient_id  uuid references public.campaign_recipients(id) on delete cascade,
  event_type    text not null,
  message       text not null default '',
  details       jsonb not null default '{}',
  created_at    timestamptz not null default now()
);
create index activity_logs_user_idx on public.activity_logs(user_id, created_at desc);
create index activity_logs_campaign_idx on public.activity_logs(campaign_id, created_at desc);

create table public.notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  type         text not null,
  title        text not null,
  body         text,
  campaign_id  uuid references public.campaigns(id) on delete cascade,
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index notifications_user_idx on public.notifications(user_id, created_at desc);

-- Fixed-window rate limiter used for unauthenticated endpoints (login, unsubscribe).
create table public.rate_limits (
  key           text primary key,
  window_start  timestamptz not null,
  hits          int not null default 0
);

------------------------------------------------------------------------------
-- updated_at triggers
------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['profiles','user_settings','connected_accounts','oauth_tokens','contacts',
                           'email_templates','campaigns','campaign_recipients','sending_jobs']
  loop
    execute format('create trigger %I_updated_at before update on public.%I for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

------------------------------------------------------------------------------
-- new-user bootstrap: profile + settings (+ starter templates, see 0005)
------------------------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', null))
  on conflict (id) do nothing;
  insert into public.user_settings(user_id) values (new.id) on conflict do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();
