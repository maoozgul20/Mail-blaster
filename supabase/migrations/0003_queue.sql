-- MailBlaster AI :: 0003 persistent queue
-- The queue is the `sending_jobs` table. Every function whose name starts with `wk_` or `_` is
-- internal (service_role only; see 0006). All of them take an explicit `p_now` so behaviour is
-- deterministic and testable; in production the default `now()` is used.

------------------------------------------------------------------------------
-- small helpers
------------------------------------------------------------------------------
create or replace function public.safe_tz(p text) returns text
language plpgsql stable as $$
declare tz text := coalesce(nullif(p, ''), 'UTC');
begin
  perform now() at time zone tz;
  return tz;
exception when others then
  return 'UTC';
end $$;

-- First instant >= p_ts that lies inside the allowed sending window (weekday + business hours).
-- Weekdays use ISO numbering: 1 = Monday ... 7 = Sunday.
create or replace function public.next_window_start(p_ts timestamptz, p_tz text, p_start time, p_end time, p_weekdays int[])
returns timestamptz language plpgsql stable as $$
declare
  tz text := public.safe_tz(p_tz);
  local_ts timestamp := p_ts at time zone tz;
  wd int[] := case when p_weekdays is null or cardinality(p_weekdays) = 0 then array[1,2,3,4,5,6,7] else p_weekdays end;
  d int; day timestamp; ws timestamp; we timestamp;
begin
  for d in 0..14 loop
    day := date_trunc('day', local_ts) + (d || ' days')::interval;
    if extract(isodow from day)::int = any(wd) then
      ws := day + p_start;
      we := day + p_end;
      if d = 0 then
        if local_ts < ws then return ws at time zone tz; end if;
        if local_ts < we then return p_ts; end if;
      else
        return ws at time zone tz;
      end if;
    end if;
  end loop;
  return p_ts;
end $$;

create or replace function public._next_day_start(p_ts timestamptz, p_tz text) returns timestamptz
language sql stable as $$
  select (date_trunc('day', p_ts at time zone public.safe_tz(p_tz)) + interval '1 day') at time zone public.safe_tz(p_tz)
$$;

create or replace function public._log(p_user uuid, p_campaign uuid, p_recipient uuid, p_type text, p_message text, p_details jsonb default '{}')
returns void language sql as $$
  insert into public.activity_logs(user_id, campaign_id, recipient_id, event_type, message, details)
  values (p_user, p_campaign, p_recipient, p_type, p_message, coalesce(p_details, '{}'::jsonb));
$$;

create or replace function public._notify(p_user uuid, p_type text, p_title text, p_body text, p_campaign uuid default null)
returns void language plpgsql as $$
declare enabled boolean;
begin
  select coalesce((notifications ->> p_type)::boolean, true) into enabled from public.user_settings where user_id = p_user;
  if coalesce(enabled, true) then
    insert into public.notifications(user_id, type, title, body, campaign_id) values (p_user, p_type, p_title, p_body, p_campaign);
  end if;
end $$;

-- Terminal skip/cancel of one job (recipient is marked skipped only for the initial email).
create or replace function public._skip_job(p_job uuid, p_reason text, p_now timestamptz, p_status text default 'skipped')
returns void language plpgsql as $$
declare j public.sending_jobs;
begin
  update public.sending_jobs
     set status = p_status, last_error = p_reason, error_class = 'skipped', completed_at = p_now,
         locked_by = null, lease_expires_at = null
   where id = p_job and status in ('queued','claimed','sending')
   returning * into j;
  if not found then return; end if;
  if j.step_number = 0 then
    update public.campaign_recipients
       set status = case when p_reason = 'unsubscribed' then 'unsubscribed' else 'skipped' end,
           skip_reason = p_reason
     where id = j.recipient_id and status in ('pending','queued');
  end if;
  perform public._log(j.user_id, j.campaign_id, j.recipient_id,
    case when j.step_number = 0 then 'job_skipped' else 'followup_cancelled' end,
    format('%s (%s)', case when j.step_number = 0 then 'Email skipped' else 'Follow-up cancelled' end, p_reason),
    jsonb_build_object('job_id', j.id, 'reason', p_reason, 'step', j.step_number));
end $$;

-- Cancel every queued follow-up for a recipient (reply, unsubscribe, bounce, suppression ...)
create or replace function public._cancel_followups(p_recipient uuid, p_reason text, p_now timestamptz default now())
returns int language plpgsql as $$
declare n int;
begin
  update public.campaign_recipients set followups_stopped = true, stop_reason = coalesce(stop_reason, p_reason)
   where id = p_recipient and not followups_stopped;
  with c as (
    update public.sending_jobs set status = 'cancelled', last_error = p_reason, error_class = 'skipped', completed_at = p_now
     where recipient_id = p_recipient and step_number > 0 and status = 'queued'
     returning user_id, campaign_id, recipient_id, id, step_number)
  select count(*) into n from c;
  return n;
end $$;

create or replace function public._maybe_complete_campaign(p_campaign uuid, p_now timestamptz)
returns void language plpgsql as $$
declare c public.campaigns;
begin
  select * into c from public.campaigns where id = p_campaign for update;
  if not found or c.status not in ('queued','running') then return; end if;
  if exists (select 1 from public.sending_jobs
              where campaign_id = p_campaign and step_number = 0 and status in ('queued','claimed','sending')) then
    return;
  end if;
  update public.campaigns set status = 'completed', completed_at = p_now where id = p_campaign;
  perform public._log(c.user_id, c.id, null, 'campaign_completed', format('Campaign "%s" completed', c.name), '{}');
  perform public._notify(c.user_id, 'campaign_completed', 'Campaign completed', format('"%s" has finished sending.', c.name), c.id);
end $$;

------------------------------------------------------------------------------
-- ATOMIC CLAIM
-- Returns a JSON array of fully-hydrated jobs (usually 0..p_limit entries, at most one per account).
-- Concurrency safety: accounts are locked with FOR UPDATE SKIP LOCKED, then candidate jobs likewise.
-- Two overlapping scheduler runs can therefore never claim the same job or send twice for one account.
------------------------------------------------------------------------------
create or replace function public.wk_claim_jobs(
  p_limit int default 10, p_lease_seconds int default 120, p_worker text default 'worker', p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  out jsonb := '[]'::jsonb;
  acc public.connected_accounts;
  j public.sending_jobs;
  c public.campaigns;
  r public.campaign_recipients;
  st public.follow_up_steps;
  sq public.follow_up_sequences;
  us public.user_settings;
  v_tz text; v_en boolean; v_start time; v_end time; v_wd int[];
  v_limit int; v_today int; v_day_start timestamptz; v_win timestamptz;
  v_min int; v_max int; v_interval int; v_inflight int;
  v_deferred uuid[]; v_reason text; v_thread jsonb;
begin
  -- 1. lease recovery -------------------------------------------------------
  -- claimed but never sent: safe to put back (poison jobs that keep dying are failed)
  update public.sending_jobs set status = 'failed', error_class = 'permanent', completed_at = p_now,
         last_error = 'Worker repeatedly lost the lease before sending', locked_by = null, lease_expires_at = null
   where status = 'claimed' and lease_expires_at < p_now and attempts >= max_attempts;
  update public.sending_jobs set status = 'queued', locked_by = null, lease_expires_at = null, run_after = p_now
   where status = 'claimed' and lease_expires_at < p_now;
  -- sending (HTTP call may have reached Gmail): NEVER requeue blindly -> ambiguous, reconcile first
  with amb as (
    update public.sending_jobs set status = 'ambiguous', locked_by = null, lease_expires_at = null, error_class = 'ambiguous',
           last_error = 'Lease expired while the Gmail request was in flight; outcome unknown (will not be retried blindly).'
     where status = 'sending' and lease_expires_at < p_now
     returning id, user_id, campaign_id, recipient_id)
  insert into public.activity_logs(user_id, campaign_id, recipient_id, event_type, message, details)
  select user_id, campaign_id, recipient_id, 'job_ambiguous',
         'Send outcome unknown after lease expiry; reconciliation required before any retry', jsonb_build_object('job_id', id)
    from amb;

  -- 2. scheduled campaigns whose start time has arrived
  update public.campaigns set status = 'queued' where status = 'scheduled' and coalesce(start_at, p_now) <= p_now;

  -- 3. per-account claim ----------------------------------------------------
  for acc in
    select a.* from public.connected_accounts a
     where a.status = 'active'
       and (a.blocked_until is null or a.blocked_until <= p_now)
       and (a.next_send_at is null or a.next_send_at <= p_now)
       and exists (select 1 from public.sending_jobs sj join public.campaigns cc on cc.id = sj.campaign_id
                    where sj.account_id = a.id and sj.status = 'queued' and sj.run_after <= p_now
                      and (cc.status in ('queued','running') or (cc.status = 'completed' and sj.step_number > 0)))
     order by a.next_send_at nulls first
     limit p_limit
     for update of a skip locked
  loop
    select count(*) into v_inflight from public.sending_jobs where account_id = acc.id and status in ('claimed','sending');
    continue when v_inflight >= acc.max_concurrent;

    v_deferred := '{}';
    for j in
      select sj.* from public.sending_jobs sj join public.campaigns cc on cc.id = sj.campaign_id
       where sj.account_id = acc.id and sj.status = 'queued' and sj.run_after <= p_now
         and (cc.status in ('queued','running') or (cc.status = 'completed' and sj.step_number > 0))
       order by sj.run_after, sj.step_number desc, sj.created_at
       limit 25
       for update of sj skip locked
    loop
      continue when j.campaign_id = any(v_deferred);
      select * into c from public.campaigns where id = j.campaign_id;
      select * into r from public.campaign_recipients where id = j.recipient_id;

      -- campaign end date
      if c.end_at is not null and p_now > c.end_at then
        perform public._skip_job(j.id, 'campaign_window_ended', p_now);
        continue;
      end if;

      -- suppression / unsubscribe, checked before EVERY send
      if r.status in ('unsubscribed','bounced')
         or exists (select 1 from public.suppression_entries s where s.user_id = j.user_id and s.email = r.email)
         or exists (select 1 from public.contacts ct where ct.user_id = j.user_id and ct.email = r.email and ct.subscription_status <> 'subscribed') then
        perform public._skip_job(j.id, case when r.status = 'unsubscribed' then 'unsubscribed' else 'suppressed' end, p_now);
        if j.step_number > 0 then perform public._cancel_followups(r.id, 'suppressed', p_now); end if;
        continue;
      end if;

      -- follow-up rules
      st := null; sq := null;
      if j.step_number > 0 then
        select fs.* into st from public.follow_up_steps fs
          join public.follow_up_sequences q on q.id = fs.sequence_id
         where q.campaign_id = j.campaign_id and fs.step_number = j.step_number;
        select * into sq from public.follow_up_sequences where campaign_id = j.campaign_id;
        v_reason := case
          when st.id is null or not st.enabled or not c.follow_ups_enabled or sq.id is null or not sq.enabled then 'followups_disabled'
          when r.followups_stopped then coalesce(r.stop_reason, 'followups_stopped')
          when r.replied_at is not null then 'replied'
          when r.status <> 'sent' then 'recipient_not_active'
          when st.condition = 'no_open' and r.open_count > 0 then 'opened'
          when st.condition = 'no_click' and r.click_count > 0 then 'clicked'
          else null end;
        if v_reason is not null then
          perform public._skip_job(j.id, v_reason, p_now, 'cancelled');
          continue;
        end if;
      end if;

      -- business hours / weekdays (campaign time zone)
      v_tz := public.safe_tz(c.settings ->> 'timezone');
      v_en := coalesce((c.settings -> 'business_hours' ->> 'enabled')::boolean, false);
      v_start := case when v_en then coalesce(nullif(c.settings -> 'business_hours' ->> 'start', ''), '09:00')::time else time '00:00' end;
      v_end   := case when v_en then coalesce(nullif(c.settings -> 'business_hours' ->> 'end', ''), '17:00')::time else time '23:59:59.999' end;
      v_wd := array(select jsonb_array_elements_text(coalesce(c.settings -> 'weekdays', '[]'::jsonb))::int);
      v_win := public.next_window_start(p_now, v_tz, v_start, v_end, v_wd);
      if v_win > p_now then
        update public.sending_jobs set run_after = v_win
         where account_id = acc.id and campaign_id = j.campaign_id and status = 'queued' and run_after <= p_now;
        v_deferred := v_deferred || j.campaign_id;
        continue;
      end if;

      -- daily limit: the campaign limit, hard-capped by the provider limit of the account
      v_day_start := date_trunc('day', p_now at time zone v_tz) at time zone v_tz;
      select count(*) into v_today from public.sending_jobs
       where account_id = acc.id and status in ('claimed','sending','submitted','ambiguous') and claimed_at >= v_day_start;
      v_limit := least(coalesce((c.settings ->> 'daily_limit')::int, 30), acc.daily_cap);
      if v_today >= v_limit then
        v_win := public.next_window_start(public._next_day_start(p_now, v_tz), v_tz, v_start, v_end, v_wd);
        update public.sending_jobs set run_after = v_win
         where account_id = acc.id and campaign_id = j.campaign_id and status = 'queued' and run_after <= p_now;
        v_deferred := v_deferred || j.campaign_id;
        perform public._log(j.user_id, c.id, null, 'daily_limit_reached',
          format('Daily limit of %s reached; resuming at %s', v_limit, v_win), jsonb_build_object('limit', v_limit, 'resume_at', v_win));
        continue;
      end if;

      -- CLAIM
      update public.sending_jobs
         set status = 'claimed', attempts = attempts + 1, locked_by = p_worker, claimed_at = p_now,
             lease_expires_at = p_now + make_interval(secs => p_lease_seconds), error_class = null
       where id = j.id;
      v_min := greatest(coalesce((c.settings ->> 'min_interval_seconds')::int, 600), 0);
      v_max := greatest(v_min, coalesce((c.settings ->> 'max_interval_seconds')::int, 1200));
      v_interval := v_min + floor(random() * (v_max - v_min + 1))::int;
      update public.connected_accounts set next_send_at = p_now + make_interval(secs => v_interval) where id = acc.id;
      if c.status = 'queued' then
        update public.campaigns set status = 'running', started_at = coalesce(started_at, p_now) where id = c.id;
        perform public._log(c.user_id, c.id, null, 'campaign_started', format('Campaign "%s" started sending', c.name), '{}');
      end if;

      select * into us from public.user_settings where user_id = j.user_id;
      v_thread := null;
      if j.step_number > 0 then
        select jsonb_build_object('thread_id', m.gmail_thread_id, 'rfc_message_id', m.rfc_message_id, 'subject', m.subject)
          into v_thread from public.email_messages m
         where m.recipient_id = r.id and m.kind = 'sent' order by m.sent_at desc limit 1;
      end if;

      out := out || jsonb_build_object(
        'job', jsonb_build_object('id', j.id, 'step_number', j.step_number, 'attempts', j.attempts + 1,
                                  'idempotency_key', j.idempotency_key, 'worker', p_worker, 'claimed_at', p_now,
                                  'user_id', j.user_id),
        'account', jsonb_build_object('id', acc.id, 'email', acc.email, 'display_name', acc.display_name, 'scopes', acc.scopes),
        'campaign', jsonb_build_object('id', c.id, 'name', c.name, 'subject', c.subject, 'body_html', c.body_html,
                                       'body_text', c.body_text, 'delivery_mode', c.delivery_mode, 'settings', c.settings,
                                       'attachments', c.attachments),
        'recipient', jsonb_build_object('id', r.id, 'email', r.email, 'first_name', r.first_name, 'last_name', r.last_name,
                                        'company', r.company, 'website', r.website, 'position', r.position,
                                        'fields', r.fields, 'token', r.token),
        'step', case when st.id is null then null else jsonb_build_object('subject', st.subject, 'body_html', st.body_html,
                      'body_text', st.body_text, 'reply_in_thread', st.reply_in_thread) end,
        'thread', v_thread,
        'user_settings', jsonb_build_object('track_opens', us.track_opens, 'track_clicks', us.track_clicks,
                                            'unsubscribe_footer', us.unsubscribe_footer, 'unsubscribe_text', us.unsubscribe_text,
                                            'signature_html', us.signature_html, 'tracking_disclosure', us.tracking_disclosure));
      exit;
    end loop;
  end loop;
  return out;
end $$;

-- Earliest moment at which any queued job could become claimable (lets the Worker pace short delays in one run).
create or replace function public.wk_peek_next_due(p_now timestamptz default now())
returns timestamptz language sql stable security definer set search_path = public as $$
  select min(greatest(sj.run_after, coalesce(a.next_send_at, p_now), coalesce(a.blocked_until, p_now)))
    from public.sending_jobs sj
    join public.connected_accounts a on a.id = sj.account_id and a.status = 'active'
    join public.campaigns c on c.id = sj.campaign_id
   where sj.status = 'queued' and (c.status in ('queued','running') or (c.status = 'completed' and sj.step_number > 0))
$$;

------------------------------------------------------------------------------
-- job lifecycle
------------------------------------------------------------------------------
-- claimed -> sending. Returns false when the job can no longer be sent (lease lost / campaign paused).
create or replace function public.wk_job_mark_sending(p_job uuid, p_worker text, p_lease_seconds int default 120, p_now timestamptz default now())
returns boolean language plpgsql security definer set search_path = public as $$
declare j public.sending_jobs; cs text;
begin
  select * into j from public.sending_jobs where id = p_job for update;
  if not found or j.status <> 'claimed' or j.locked_by is distinct from p_worker then return false; end if;
  select status into cs from public.campaigns where id = j.campaign_id;
  if cs in ('paused','draft','scheduled') then
    update public.sending_jobs set status = 'queued', locked_by = null, lease_expires_at = null, attempts = greatest(attempts - 1, 0) where id = p_job;
    return false;
  elsif cs in ('cancelled','failed') or cs is null then
    perform public._skip_job(p_job, 'campaign_' || coalesce(cs, 'deleted'), p_now, 'cancelled');
    return false;
  end if;
  update public.sending_jobs set status = 'sending', lease_expires_at = p_now + make_interval(secs => p_lease_seconds) where id = p_job;
  return true;
end $$;

-- Gmail confirmed the submission. THIS is the only place a job becomes `submitted`.
create or replace function public.wk_job_complete_sent(
  p_job uuid, p_kind text, p_gmail_message_id text, p_thread_id text, p_rfc_id text, p_subject text, p_to text,
  p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  j public.sending_jobs; c public.campaigns; sq public.follow_up_sequences; nxt public.follow_up_steps;
  v_next jsonb := null;
begin
  select * into j from public.sending_jobs where id = p_job for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if j.status = 'submitted' then return jsonb_build_object('ok', true, 'duplicate', true); end if;
  if j.status not in ('sending','ambiguous','claimed') then
    return jsonb_build_object('ok', false, 'error', 'bad_status:' || j.status);
  end if;
  update public.sending_jobs set status = 'submitted', completed_at = p_now, locked_by = null, lease_expires_at = null,
         error_class = null, last_error = null where id = p_job;

  insert into public.email_messages(user_id, campaign_id, recipient_id, job_id, account_id, step_number, kind,
                                    rfc_message_id, gmail_message_id, gmail_thread_id, subject, to_email, sent_at)
  values (j.user_id, j.campaign_id, j.recipient_id, j.id, j.account_id, j.step_number, case when p_kind = 'draft' then 'draft' else 'sent' end,
          p_rfc_id, p_gmail_message_id, p_thread_id, p_subject, p_to, p_now)
  on conflict (job_id) do nothing;

  select * into c from public.campaigns where id = j.campaign_id;
  if p_kind = 'draft' then
    update public.campaign_recipients set status = 'drafted', sent_at = p_now where id = j.recipient_id;
    perform public._log(j.user_id, j.campaign_id, j.recipient_id, 'draft_created', 'Gmail draft created for ' || p_to,
                        jsonb_build_object('job_id', j.id, 'gmail_message_id', p_gmail_message_id));
  elsif j.step_number = 0 then
    update public.campaign_recipients set status = 'sent', sent_at = p_now where id = j.recipient_id;
    perform public._log(j.user_id, j.campaign_id, j.recipient_id, 'email_submitted', 'Email submitted to Gmail for ' || p_to,
                        jsonb_build_object('job_id', j.id, 'gmail_message_id', p_gmail_message_id, 'thread_id', p_thread_id));
  else
    update public.campaign_recipients set follow_ups_sent = follow_ups_sent + 1 where id = j.recipient_id;
    perform public._log(j.user_id, j.campaign_id, j.recipient_id, 'followup_submitted',
                        format('Follow-up %s submitted to Gmail for %s', j.step_number, p_to),
                        jsonb_build_object('job_id', j.id, 'gmail_message_id', p_gmail_message_id, 'step', j.step_number));
  end if;

  -- schedule the next enabled follow-up stage (unique(recipient_id, step_number) makes this idempotent)
  if p_kind <> 'draft' and c.follow_ups_enabled then
    select * into sq from public.follow_up_sequences where campaign_id = j.campaign_id and enabled;
    if found then
      select * into nxt from public.follow_up_steps where sequence_id = sq.id and enabled and step_number > j.step_number
       order by step_number limit 1;
      if found then
        insert into public.sending_jobs(user_id, campaign_id, recipient_id, account_id, step_number, status, run_after, idempotency_key)
        values (j.user_id, j.campaign_id, j.recipient_id, j.account_id, nxt.step_number, 'queued',
                p_now + make_interval(mins => nxt.delay_minutes), j.recipient_id::text || ':' || nxt.step_number)
        on conflict do nothing;
        v_next := jsonb_build_object('step', nxt.step_number, 'run_after', p_now + make_interval(mins => nxt.delay_minutes));
        perform public._log(j.user_id, j.campaign_id, j.recipient_id, 'followup_scheduled',
                            format('Follow-up %s scheduled for %s', nxt.step_number, p_to),
                            jsonb_build_object('step', nxt.step_number, 'run_after', p_now + make_interval(mins => nxt.delay_minutes)));
      end if;
    end if;
  end if;

  perform public._maybe_complete_campaign(j.campaign_id, p_now);
  return jsonb_build_object('ok', true, 'next_followup', v_next);
end $$;

-- Failure handling. p_class: transient | permanent | invalid_recipient | auth | quota
create or replace function public.wk_job_complete_failed(
  p_job uuid, p_class text, p_message text, p_block_seconds int default 3600, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare j public.sending_jobs; a public.connected_accounts; v_delay int; v_final boolean := false; c public.campaigns;
begin
  select * into j from public.sending_jobs where id = p_job for update;
  if not found or j.status not in ('claimed','sending') then return jsonb_build_object('ok', false); end if;
  select * into c from public.campaigns where id = j.campaign_id;

  if p_class = 'auth' then
    update public.connected_accounts set status = 'reauth_required', last_error = left(p_message, 500), last_error_at = p_now
     where id = j.account_id returning * into a;
    update public.sending_jobs set status = 'queued', attempts = greatest(attempts - 1, 0), locked_by = null, lease_expires_at = null,
           run_after = p_now, error_class = 'auth', last_error = left(p_message, 500) where id = p_job;
    perform public._log(j.user_id, j.campaign_id, j.recipient_id, 'account_reauth_required',
                        'Gmail authorization expired or revoked for ' || coalesce(a.email, 'account'), jsonb_build_object('job_id', j.id));
    perform public._notify(j.user_id, 'failed_sending', 'Reconnect Gmail',
                           'Gmail authorization for ' || coalesce(a.email, 'your account') || ' needs to be renewed. Sending is on hold.', j.campaign_id);
  elsif p_class = 'quota' then
    update public.connected_accounts set blocked_until = p_now + make_interval(secs => p_block_seconds),
           blocked_reason = left(p_message, 500), last_error = left(p_message, 500), last_error_at = p_now
     where id = j.account_id;
    update public.sending_jobs set status = 'queued', attempts = greatest(attempts - 1, 0), locked_by = null, lease_expires_at = null,
           run_after = p_now + make_interval(secs => p_block_seconds), error_class = 'quota', last_error = left(p_message, 500)
     where id = p_job;
    perform public._log(j.user_id, j.campaign_id, j.recipient_id, 'quota_exceeded',
                        'Gmail quota reached; account paused for ' || p_block_seconds || 's', jsonb_build_object('job_id', j.id));
  elsif p_class = 'transient' and j.attempts < j.max_attempts then
    v_delay := least(21600, 60 * power(2, j.attempts)::int) + floor(random() * 30)::int;
    update public.sending_jobs set status = 'queued', locked_by = null, lease_expires_at = null,
           run_after = p_now + make_interval(secs => v_delay), error_class = 'transient', last_error = left(p_message, 500)
     where id = p_job;
    perform public._log(j.user_id, j.campaign_id, j.recipient_id, 'job_retry_scheduled',
                        format('Temporary failure, retry %s/%s in %ss: %s', j.attempts, j.max_attempts, v_delay, left(p_message, 200)),
                        jsonb_build_object('job_id', j.id, 'attempts', j.attempts));
  else
    v_final := true;
    update public.sending_jobs set status = 'failed', completed_at = p_now, locked_by = null, lease_expires_at = null,
           error_class = case when p_class = 'transient' then 'transient_exhausted' else p_class end, last_error = left(p_message, 500)
     where id = p_job;
    if j.step_number = 0 then
      update public.campaign_recipients set status = 'failed', failure_reason = left(p_message, 500) where id = j.recipient_id;
    end if;
    perform public._log(j.user_id, j.campaign_id, j.recipient_id, 'job_failed', 'Sending failed: ' || left(p_message, 300),
                        jsonb_build_object('job_id', j.id, 'class', p_class));
    perform public._notify(j.user_id, 'failed_sending', 'Email failed to send', left(p_message, 300), j.campaign_id);
    perform public._maybe_complete_campaign(j.campaign_id, p_now);
  end if;
  return jsonb_build_object('ok', true, 'final', v_final);
end $$;

-- The HTTP request was sent but we never saw a verdict (timeout/connection drop): do not retry blindly.
create or replace function public.wk_job_mark_ambiguous(p_job uuid, p_message text, p_now timestamptz default now())
returns void language plpgsql security definer set search_path = public as $$
declare j public.sending_jobs;
begin
  update public.sending_jobs set status = 'ambiguous', locked_by = null, lease_expires_at = null, error_class = 'ambiguous',
         last_error = left(p_message, 500)
   where id = p_job and status in ('sending','claimed') returning * into j;
  if found then
    perform public._log(j.user_id, j.campaign_id, j.recipient_id, 'job_ambiguous',
                        'Gmail request outcome unknown; checking Sent mail before any retry', jsonb_build_object('job_id', j.id));
  end if;
end $$;

-- Reconciliation verdict "Gmail has no such message": safe to queue again.
create or replace function public.wk_job_requeue_ambiguous(p_job uuid, p_now timestamptz default now())
returns boolean language plpgsql security definer set search_path = public as $$
declare j public.sending_jobs;
begin
  update public.sending_jobs set status = 'queued', run_after = p_now, last_error = 'Reconciled: message not found in Gmail, re-queued',
         error_class = null where id = p_job and status = 'ambiguous' returning * into j;
  if found then
    perform public._log(j.user_id, j.campaign_id, j.recipient_id, 'job_requeued', 'Reconciled with Gmail: not sent, re-queued',
                        jsonb_build_object('job_id', j.id));
  end if;
  return found;
end $$;

create or replace function public.wk_list_ambiguous(p_limit int default 10)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'job_id', j.id, 'account_id', j.account_id, 'to', r.email, 'claimed_at', j.claimed_at,
      'scopes', a.scopes, 'subject', c.subject, 'step_number', j.step_number)), '[]'::jsonb)
  from (select * from public.sending_jobs where status = 'ambiguous' order by updated_at limit p_limit) j
  join public.campaign_recipients r on r.id = j.recipient_id
  join public.campaigns c on c.id = j.campaign_id
  join public.connected_accounts a on a.id = j.account_id
$$;

-- User-facing resolution for ambiguous jobs when the account has no read scope to reconcile automatically.
create or replace function public.resolve_job(p_job uuid, p_outcome text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare j public.sending_jobs; r public.campaign_recipients;
begin
  select * into j from public.sending_jobs where id = p_job and user_id = auth.uid() for update;
  if not found then raise exception 'job not found'; end if;
  if j.status <> 'ambiguous' then raise exception 'job is not ambiguous'; end if;
  select * into r from public.campaign_recipients where id = j.recipient_id;
  if p_outcome = 'sent' then
    return public.wk_job_complete_sent(p_job, 'sent', null, null, null, null, r.email, now());
  elsif p_outcome = 'retry' then
    return jsonb_build_object('ok', public.wk_job_requeue_ambiguous(p_job, now()));
  end if;
  raise exception 'outcome must be sent or retry';
end $$;
