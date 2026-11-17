-- MailBlaster AI :: 0004 tracking, unsubscribe, replies, bounces, accounts, rate limits
-- Everything here is service_role only (wk_ prefix), called by public Worker endpoints or the cron.

create or replace function public._valid_email(p text) returns boolean
language sql immutable as $$
  select p is not null and length(p) <= 254
     and p ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
$$;

-- Cancel everything still queued for this address across all of the user's campaigns.
create or replace function public._cancel_all_for_email(p_user uuid, p_email text, p_reason text, p_now timestamptz)
returns void language plpgsql as $$
begin
  update public.sending_jobs set status = 'cancelled', last_error = p_reason, error_class = 'skipped', completed_at = p_now
   where status = 'queued'
     and recipient_id in (select id from public.campaign_recipients where user_id = p_user and email = p_email);
  update public.campaign_recipients
     set followups_stopped = true,
         stop_reason = coalesce(stop_reason, p_reason),
         skip_reason = case when status in ('pending','queued') then p_reason else skip_reason end,
         status = case when status in ('pending','queued')
                       then (case when p_reason = 'unsubscribed' then 'unsubscribed' else 'skipped' end) else status end
   where user_id = p_user and email = p_email;
end $$;

------------------------------------------------------------------------------
-- open / click tracking
-- Hits within a few seconds of submission are almost always security scanners or prefetchers:
-- they are stored (transparency) but flagged counted=false and not added to open/click counts.
------------------------------------------------------------------------------
create or replace function public.wk_track_open(p_token text, p_ua text default null, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.campaign_recipients; v_counted boolean;
begin
  select * into r from public.campaign_recipients where token = p_token;
  if not found then return jsonb_build_object('ok', false); end if;
  v_counted := r.sent_at is not null and p_now - r.sent_at >= interval '8 seconds';
  insert into public.tracking_events(user_id, campaign_id, recipient_id, event_type, user_agent, counted, created_at)
  values (r.user_id, r.campaign_id, r.id, 'open', left(p_ua, 300), v_counted, p_now);
  if v_counted then
    update public.campaign_recipients
       set open_count = open_count + 1, opened_at = coalesce(opened_at, p_now), last_opened_at = p_now
     where id = r.id;
    if r.opened_at is null then
      perform public._log(r.user_id, r.campaign_id, r.id, 'email_opened', r.email || ' opened the email', '{}');
    end if;
  end if;
  return jsonb_build_object('ok', true, 'counted', v_counted);
end $$;

create or replace function public.wk_track_click(p_token text, p_url text, p_ua text default null, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.campaign_recipients; v_counted boolean;
begin
  select * into r from public.campaign_recipients where token = p_token;
  if not found then return jsonb_build_object('ok', false); end if;
  v_counted := r.sent_at is not null and p_now - r.sent_at >= interval '5 seconds';
  insert into public.tracking_events(user_id, campaign_id, recipient_id, event_type, url, user_agent, counted, created_at)
  values (r.user_id, r.campaign_id, r.id, 'click', left(p_url, 2000), left(p_ua, 300), v_counted, p_now);
  if v_counted then
    update public.campaign_recipients
       set click_count = click_count + 1, first_clicked_at = coalesce(first_clicked_at, p_now), last_clicked_at = p_now
     where id = r.id;
    perform public._log(r.user_id, r.campaign_id, r.id, 'link_clicked', r.email || ' clicked a link',
                        jsonb_build_object('url', left(p_url, 500)));
  end if;
  return jsonb_build_object('ok', true, 'counted', v_counted);
end $$;

------------------------------------------------------------------------------
-- unsubscribe (idempotent)
------------------------------------------------------------------------------
create or replace function public.wk_record_unsubscribe(p_token text, p_method text default 'link', p_ua text default null, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.campaign_recipients; v_new boolean;
begin
  select * into r from public.campaign_recipients where token = p_token;
  if not found then return jsonb_build_object('ok', false); end if;

  insert into public.suppression_entries(user_id, email, reason, source)
  values (r.user_id, r.email, 'unsubscribed', 'unsubscribe link') on conflict (user_id, email) do nothing;
  get diagnostics v_new = row_count;

  update public.contacts set subscription_status = 'unsubscribed'
   where user_id = r.user_id and email = r.email and subscription_status = 'subscribed';

  perform public._cancel_all_for_email(r.user_id, r.email, 'unsubscribed', p_now);
  update public.campaign_recipients set status = 'unsubscribed' where id = r.id;

  if v_new then
    insert into public.unsubscribe_events(user_id, campaign_id, recipient_id, email, method, user_agent, created_at)
    values (r.user_id, r.campaign_id, r.id, r.email, case when p_method = 'one_click' then 'one_click' else 'link' end, left(p_ua, 300), p_now);
    perform public._log(r.user_id, r.campaign_id, r.id, 'unsubscribed', r.email || ' unsubscribed', jsonb_build_object('method', p_method));
  end if;
  return jsonb_build_object('ok', true, 'email', r.email, 'already', not v_new);
end $$;

-- Minimal public lookup for the unsubscribe confirmation page (never returns more than the address)
create or replace function public.wk_unsubscribe_info(p_token text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((select jsonb_build_object('email', r.email, 'unsubscribed', r.status = 'unsubscribed'
                          or exists (select 1 from public.suppression_entries s where s.user_id = r.user_id and s.email = r.email))
                     from public.campaign_recipients r where r.token = p_token), jsonb_build_object('email', null))
$$;

------------------------------------------------------------------------------
-- replies & bounces (matched by Gmail thread id of the message we submitted)
------------------------------------------------------------------------------
create or replace function public.wk_record_reply(
  p_account uuid, p_thread text, p_msg text, p_from text, p_snippet text, p_received timestamptz, p_now timestamptz default now())
returns text language plpgsql security definer set search_path = public as $$
declare m public.email_messages; r public.campaign_recipients; a public.connected_accounts; v_id uuid;
begin
  select * into a from public.connected_accounts where id = p_account;
  if not found then return 'no_account'; end if;
  if lower(coalesce(p_from, '')) = lower(a.email) then return 'self'; end if;
  select * into m from public.email_messages
   where account_id = p_account and gmail_thread_id = p_thread and kind = 'sent' order by sent_at desc limit 1;
  if not found then return 'unmatched'; end if;
  select * into r from public.campaign_recipients where id = m.recipient_id;
  -- Replies from someone other than the recipient (assistant, forwarded) still count as a human reply.
  insert into public.replies(user_id, campaign_id, recipient_id, gmail_message_id, gmail_thread_id, from_email, snippet, received_at)
  values (r.user_id, r.campaign_id, r.id, p_msg, p_thread, lower(p_from), left(p_snippet, 500), coalesce(p_received, p_now))
  on conflict (gmail_message_id) do nothing returning id into v_id;
  if v_id is null then return 'duplicate'; end if;

  update public.campaign_recipients
     set replied_at = coalesce(replied_at, coalesce(p_received, p_now)), reply_preview = left(p_snippet, 300)
   where id = r.id;
  perform public._cancel_followups(r.id, 'reply', p_now);
  perform public._log(r.user_id, r.campaign_id, r.id, 'reply_received', r.email || ' replied', jsonb_build_object('snippet', left(p_snippet, 200)));
  perform public._notify(r.user_id, 'reply_received', 'New reply from ' || r.email, left(p_snippet, 200), r.campaign_id);
  return 'recorded';
end $$;

create or replace function public.wk_record_bounce(
  p_account uuid, p_thread text, p_msg text, p_type text, p_reason text, p_now timestamptz default now())
returns text language plpgsql security definer set search_path = public as $$
declare m public.email_messages; r public.campaign_recipients; v_id uuid;
begin
  select * into m from public.email_messages
   where account_id = p_account and gmail_thread_id = p_thread and kind = 'sent' order by sent_at desc limit 1;
  if not found then return 'unmatched'; end if;
  select * into r from public.campaign_recipients where id = m.recipient_id;
  insert into public.bounces(user_id, campaign_id, recipient_id, bounce_type, reason, gmail_message_id, detected_at)
  values (r.user_id, r.campaign_id, r.id, p_type, left(p_reason, 500), p_msg, p_now)
  on conflict (gmail_message_id) do nothing returning id into v_id;
  if v_id is null then return 'duplicate'; end if;

  if p_type = 'permanent' then
    perform public._cancel_all_for_email(r.user_id, r.email, 'bounced', p_now);
    update public.campaign_recipients set status = 'bounced', failure_reason = left(p_reason, 500) where id = r.id;
    insert into public.suppression_entries(user_id, email, reason, source)
    values (r.user_id, r.email, 'bounced', 'permanent bounce') on conflict (user_id, email) do nothing;
    perform public._log(r.user_id, r.campaign_id, r.id, 'bounce_detected', r.email || ' permanently bounced',
                        jsonb_build_object('reason', left(p_reason, 300)));
    perform public._notify(r.user_id, 'failed_sending', 'Email bounced', r.email || ': ' || left(p_reason, 200), r.campaign_id);
  else
    perform public._log(r.user_id, r.campaign_id, r.id, 'bounce_temporary', 'Temporary delivery problem for ' || r.email,
                        jsonb_build_object('reason', left(p_reason, 300)));
  end if;
  return 'recorded';
end $$;

------------------------------------------------------------------------------
-- accounts & tokens (ciphertext only ever comes from the Worker)
------------------------------------------------------------------------------
create or replace function public.wk_upsert_account(
  p_user uuid, p_email text, p_name text, p_scopes text[], p_refresh_enc text, p_access_enc text, p_access_expires timestamptz,
  p_now timestamptz default now())
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.connected_accounts(user_id, email, display_name, status, scopes)
  values (p_user, lower(p_email), p_name, 'active', coalesce(p_scopes, '{}'))
  on conflict (user_id, email) do update
    set status = 'active', scopes = coalesce(p_scopes, '{}'), display_name = coalesce(excluded.display_name, public.connected_accounts.display_name),
        last_error = null, blocked_until = null, blocked_reason = null
  returning id into v_id;

  insert into public.oauth_tokens(account_id, refresh_token_enc, access_token_enc, access_expires_at)
  values (v_id, coalesce(p_refresh_enc, ''), p_access_enc, p_access_expires)
  on conflict (account_id) do update
    set refresh_token_enc = case when excluded.refresh_token_enc = '' then public.oauth_tokens.refresh_token_enc else excluded.refresh_token_enc end,
        access_token_enc = excluded.access_token_enc, access_expires_at = excluded.access_expires_at;

  -- jobs held back by a reauthorization pause resume automatically
  perform public._log(p_user, null, null, 'audit.account_connected', 'Gmail account connected: ' || lower(p_email),
                      jsonb_build_object('scopes', p_scopes));
  return v_id;
end $$;

create or replace function public.wk_store_access_token(p_account uuid, p_access_enc text, p_expires timestamptz)
returns void language sql security definer set search_path = public as $$
  update public.oauth_tokens set access_token_enc = p_access_enc, access_expires_at = p_expires where account_id = p_account;
$$;

create or replace function public.wk_disconnect_account(p_account uuid, p_now timestamptz default now())
returns void language plpgsql security definer set search_path = public as $$
declare a public.connected_accounts;
begin
  select * into a from public.connected_accounts where id = p_account;
  if not found then return; end if;
  delete from public.oauth_tokens where account_id = p_account;
  update public.connected_accounts set status = 'disconnected', scopes = '{}' where id = p_account;
  update public.campaigns set status = 'paused', paused_at = p_now
   where account_id = p_account and status in ('scheduled','queued','running');
  perform public._log(a.user_id, null, null, 'audit.account_disconnected', 'Gmail account disconnected: ' || a.email, '{}');
end $$;

create or replace function public.wk_accounts_for_reply_check(p_min_age_seconds int default 240, p_limit int default 3, p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'email', a.email, 'user_id', a.user_id,
           'last_check', a.last_reply_check_at, 'scopes', a.scopes)), '[]'::jsonb)
    from (select * from public.connected_accounts a
           where a.status = 'active' and 'https://www.googleapis.com/auth/gmail.readonly' = any(a.scopes)
             and (a.last_reply_check_at is null or a.last_reply_check_at < p_now - make_interval(secs => p_min_age_seconds))
             and exists (select 1 from public.email_messages m where m.account_id = a.id and m.kind = 'sent'
                          and m.sent_at > p_now - interval '45 days')
           order by a.last_reply_check_at nulls first limit p_limit) a
$$;

create or replace function public.wk_set_reply_checked(p_account uuid, p_at timestamptz)
returns void language sql security definer set search_path = public as $$
  update public.connected_accounts set last_reply_check_at = p_at where id = p_account;
$$;

create or replace function public.wk_thread_ids_for_account(p_account uuid, p_limit int default 500)
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct m.gmail_thread_id), '{}')
    from (select gmail_thread_id from public.email_messages
           where account_id = p_account and kind = 'sent' and gmail_thread_id is not null
             and sent_at > now() - interval '45 days' order by sent_at desc limit p_limit) m
$$;

------------------------------------------------------------------------------
-- rate limiting + housekeeping
------------------------------------------------------------------------------
create or replace function public.wk_rate_limit(p_key text, p_window_seconds int, p_max int, p_now timestamptz default now())
returns boolean language plpgsql security definer set search_path = public as $$
declare v int;
begin
  insert into public.rate_limits as rl(key, window_start, hits) values (p_key, p_now, 1)
  on conflict (key) do update
     set window_start = case when rl.window_start < p_now - make_interval(secs => p_window_seconds) then p_now else rl.window_start end,
         hits = case when rl.window_start < p_now - make_interval(secs => p_window_seconds) then 1 else rl.hits + 1 end
  returning hits into v;
  return v <= p_max;
end $$;

create or replace function public.wk_cleanup(p_now timestamptz default now())
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.rate_limits where window_start < p_now - interval '1 day';
  delete from public.notifications where created_at < p_now - interval '90 days';
  delete from public.activity_logs where created_at < p_now - interval '180 days';
end $$;
