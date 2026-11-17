-- MailBlaster AI :: 0005 user-facing campaign API (called by the Worker with the USER's JWT)
-- Mutations are SECURITY DEFINER with explicit auth.uid() ownership checks because authenticated
-- users have no direct write access to campaigns / recipients / jobs. Reads are SECURITY INVOKER (RLS).

create or replace function public._uid() returns uuid language plpgsql stable as $$
declare u uuid := auth.uid();
begin
  if u is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  return u;
end $$;

create or replace function public._is_suppressed(p_user uuid, p_email text) returns boolean
language sql stable as $$
  select exists (select 1 from public.suppression_entries s where s.user_id = p_user and s.email = p_email)
      or exists (select 1 from public.contacts c where c.user_id = p_user and c.email = p_email and c.subscription_status <> 'subscribed')
$$;

-- Which of these addresses would be excluded? (used by the recipient preview in the UI)
create or replace function public.check_suppressed(p_emails text[]) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(e), '{}') from (select lower(btrim(x)) e from unnest(p_emails) x) t
   where public._is_suppressed(public._uid(), e)
$$;

------------------------------------------------------------------------------
-- save_campaign: create (p_id null) or update a DRAFT; replaces recipients / follow-up steps when supplied
------------------------------------------------------------------------------
create or replace function public.save_campaign(p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public._uid();
  c public.campaigns;
  us public.user_settings;
  v_settings jsonb; v_defaults jsonb; v_account uuid; v_new boolean := (p_id is null);
  v_inserted int := 0; v_invalid int := 0; v_dups int := 0; v_supp int := 0;
  v_att jsonb; v_att_size bigint; step jsonb; n int := 0; sq_id uuid;
  v_start time; v_end time; v_wd jsonb; v_mode text;
begin
  select * into us from public.user_settings where user_id = uid;

  if v_new then
    if coalesce(btrim(p ->> 'name'), '') = '' then raise exception 'campaign name is required'; end if;
    insert into public.campaigns(user_id, name) values (uid, left(btrim(p ->> 'name'), 200)) returning * into c;
  else
    select * into c from public.campaigns where id = p_id and user_id = uid for update;
    if not found then raise exception 'campaign not found'; end if;
    if c.status <> 'draft' then raise exception 'only draft campaigns can be edited (status: %)', c.status; end if;
  end if;

  v_account := coalesce(nullif(p ->> 'account_id', '')::uuid, c.account_id,
                        (select id from public.connected_accounts where user_id = uid and status = 'active' order by created_at limit 1));
  v_mode := coalesce(p ->> 'delivery_mode', c.delivery_mode);
  if v_mode not in ('send','draft') then raise exception 'delivery_mode must be send or draft'; end if;

  -- settings: user defaults <- stored <- request, then validated
  v_defaults := jsonb_build_object(
      'daily_limit', us.daily_limit, 'min_interval_seconds', us.min_interval_seconds, 'max_interval_seconds', us.max_interval_seconds,
      'timezone', us.timezone, 'business_hours', us.business_hours, 'weekdays', to_jsonb(us.weekdays),
      'track_opens', us.track_opens, 'track_clicks', us.track_clicks, 'unsubscribe_link', us.unsubscribe_footer, 'reply_in_thread', true);
  v_settings := v_defaults || coalesce(c.settings, '{}'::jsonb) || coalesce(p -> 'settings', '{}'::jsonb);
  if (v_settings ->> 'daily_limit')::int not between 1 and 2000 then raise exception 'daily_limit must be between 1 and 2000'; end if;
  if (v_settings ->> 'min_interval_seconds')::int < 0
     or (v_settings ->> 'max_interval_seconds')::int < (v_settings ->> 'min_interval_seconds')::int then
    raise exception 'interval range is invalid (min must be <= max)';
  end if;
  if (v_settings ->> 'max_interval_seconds')::int > 86400 then raise exception 'maximum interval is 24 hours'; end if;
  v_wd := v_settings -> 'weekdays';
  if jsonb_typeof(v_wd) <> 'array' or exists (select 1 from jsonb_array_elements_text(v_wd) w where w::int not between 1 and 7) then
    raise exception 'weekdays must be an array of 1..7 (Monday=1)';
  end if;
  if coalesce((v_settings -> 'business_hours' ->> 'enabled')::boolean, false) then
    v_start := (v_settings -> 'business_hours' ->> 'start')::time;
    v_end := (v_settings -> 'business_hours' ->> 'end')::time;
    if v_start >= v_end then raise exception 'business hours start must be before end'; end if;
  end if;
  v_settings := jsonb_set(v_settings, '{timezone}', to_jsonb(public.safe_tz(v_settings ->> 'timezone')));

  -- attachments: <= 3 files, <= 2 MB total, only inside the caller's own storage prefix
  v_att := coalesce(p -> 'attachments', c.attachments, '[]'::jsonb);
  if jsonb_typeof(v_att) <> 'array' or jsonb_array_length(v_att) > 3 then raise exception 'at most 3 attachments are allowed'; end if;
  select coalesce(sum((a ->> 'size')::bigint), 0) into v_att_size from jsonb_array_elements(v_att) a;
  if v_att_size > 2097152 then raise exception 'attachments exceed 2 MB total'; end if;
  if exists (select 1 from jsonb_array_elements(v_att) a where left(a ->> 'path', length(uid::text) + 1) <> uid::text || '/') then
    raise exception 'attachment path is not owned by the user';
  end if;

  update public.campaigns set
    name = left(coalesce(nullif(btrim(p ->> 'name'), ''), name), 200),
    subject = left(coalesce(p ->> 'subject', subject), 998),
    body_html = left(coalesce(p ->> 'body_html', body_html), 500000),
    body_text = case when p ? 'body_text' then left(p ->> 'body_text', 200000) else body_text end,
    template_id = case when p ? 'template_id' then nullif(p ->> 'template_id', '')::uuid else template_id end,
    delivery_mode = v_mode,
    account_id = v_account,
    settings = v_settings,
    attachments = v_att,
    follow_ups_enabled = coalesce((p #>> '{follow_ups,enabled}')::boolean, follow_ups_enabled),
    start_at = case when p ? 'start_at' then nullif(p ->> 'start_at', '')::timestamptz else start_at end,
    end_at = case when p ? 'end_at' then nullif(p ->> 'end_at', '')::timestamptz else end_at end
  where id = c.id returning * into c;

  if v_new then
    perform public._log(uid, c.id, null, 'campaign_created', format('Campaign "%s" created', c.name), '{}');
  end if;

  -- follow-up sequence
  if p ? 'follow_ups' and jsonb_typeof(p -> 'follow_ups' -> 'steps') = 'array' then
    insert into public.follow_up_sequences(campaign_id, user_id, enabled)
    values (c.id, uid, coalesce((p #>> '{follow_ups,enabled}')::boolean, true))
    on conflict (campaign_id) do update set enabled = excluded.enabled
    returning id into sq_id;
    delete from public.follow_up_steps where sequence_id = sq_id;
    for step in select * from jsonb_array_elements(p -> 'follow_ups' -> 'steps') loop
      n := n + 1;
      if n > 10 then raise exception 'at most 10 follow-up stages are allowed'; end if;
      insert into public.follow_up_steps(sequence_id, user_id, step_number, enabled, delay_minutes, condition, subject, body_html, body_text, reply_in_thread)
      values (sq_id, uid, n, coalesce((step ->> 'enabled')::boolean, true),
              greatest(1, coalesce((step ->> 'delay_minutes')::int, round(coalesce((step ->> 'delay_days')::numeric, 3) * 1440)::int)),
              coalesce(nullif(step ->> 'condition', ''), 'no_reply'),
              left(coalesce(step ->> 'subject', ''), 998), left(coalesce(step ->> 'body_html', ''), 200000), step ->> 'body_text',
              coalesce((step ->> 'reply_in_thread')::boolean, true));
    end loop;
  end if;

  -- recipients: replace the whole list of a draft (one row per person)
  if p ? 'recipients' and jsonb_typeof(p -> 'recipients') = 'array' then
    if jsonb_array_length(p -> 'recipients') > 5000 then raise exception 'at most 5000 recipients per campaign'; end if;
    delete from public.campaign_recipients where campaign_id = c.id;

    select count(*) filter (where not ok), count(*) filter (where ok and rn > 1) into v_invalid, v_dups
      from (select public._valid_email(lower(btrim(t.e ->> 'email'))) as ok,
                   row_number() over (partition by lower(btrim(t.e ->> 'email')) order by t.ord) as rn
              from jsonb_array_elements(p -> 'recipients') with ordinality as t(e, ord)) q;

    with raw as (
      select t.ord, lower(btrim(t.e ->> 'email')) as email, t.e
        from jsonb_array_elements(p -> 'recipients') with ordinality as t(e, ord)),
    checked as (
      select raw.*, public._valid_email(email) as ok,
             row_number() over (partition by email order by ord) as rn
        from raw),
    ins as (
      insert into public.campaign_recipients(campaign_id, user_id, contact_id, email, first_name, last_name, company, website, position, fields, status, skip_reason)
      select c.id, uid,
             (select ct.id from public.contacts ct where ct.user_id = uid and ct.id = nullif(e ->> 'contact_id', '')::uuid),
             email,
             left(nullif(btrim(e ->> 'first_name'), ''), 200), left(nullif(btrim(e ->> 'last_name'), ''), 200),
             left(nullif(btrim(e ->> 'company'), ''), 300), left(nullif(btrim(e ->> 'website'), ''), 300),
             left(nullif(btrim(e ->> 'position'), ''), 300),
             case when jsonb_typeof(e -> 'fields') = 'object' then e -> 'fields' else '{}'::jsonb end,
             case when public._is_suppressed(uid, email) then 'skipped' else 'pending' end,
             case when public._is_suppressed(uid, email) then 'suppressed' end
        from checked where ok and rn = 1 order by ord
      returning status)
    select count(*), count(*) filter (where status = 'skipped') into v_inserted, v_supp from ins;
  end if;

  return jsonb_build_object('id', c.id, 'inserted', v_inserted, 'invalid', v_invalid, 'duplicates', v_dups, 'suppressed', v_supp);
end $$;

------------------------------------------------------------------------------
-- lifecycle
------------------------------------------------------------------------------
create or replace function public.start_campaign(p_id uuid, p_start_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public._uid();
  c public.campaigns; a public.connected_accounts;
  v_start timestamptz; v_queued int; v_skipped int; v_status text;
begin
  select * into c from public.campaigns where id = p_id and user_id = uid for update;
  if not found then raise exception 'campaign not found'; end if;
  if c.status <> 'draft' then raise exception 'campaign already started (status: %)', c.status; end if;
  if c.account_id is null then raise exception 'connect a Gmail account first'; end if;
  select * into a from public.connected_accounts where id = c.account_id;
  if a.status <> 'active' then raise exception 'Gmail account % must be reconnected (status: %)', a.email, a.status; end if;
  if c.delivery_mode = 'draft' and not ('https://www.googleapis.com/auth/gmail.compose' = any(a.scopes)) then
    raise exception 'creating Gmail drafts requires the gmail.compose permission; reconnect the account with it enabled';
  end if;
  if btrim(c.subject) = '' then raise exception 'subject is required'; end if;
  if btrim(c.body_html) = '' then raise exception 'message body is required'; end if;

  v_start := greatest(coalesce(p_start_at, c.start_at, now()), now());
  if c.end_at is not null and c.end_at <= v_start then raise exception 'campaign end date must be after the start time'; end if;

  -- exclusions are evaluated again at start (list may have changed since the draft was saved)
  update public.campaign_recipients set status = 'skipped', skip_reason = 'suppressed'
   where campaign_id = c.id and status = 'pending' and public._is_suppressed(uid, email);

  insert into public.sending_jobs(user_id, campaign_id, recipient_id, account_id, step_number, status, run_after, idempotency_key)
  select uid, c.id, r.id, c.account_id, 0, 'queued', v_start, r.id::text || ':0'
    from public.campaign_recipients r where r.campaign_id = c.id and r.status = 'pending'
  on conflict do nothing;
  get diagnostics v_queued = row_count;
  if v_queued = 0 then raise exception 'no eligible recipients (all excluded, invalid, suppressed or the list is empty)'; end if;

  update public.campaign_recipients set status = 'queued' where campaign_id = c.id and status = 'pending';
  select count(*) into v_skipped from public.campaign_recipients where campaign_id = c.id and status = 'skipped';

  v_status := case when v_start > now() + interval '30 seconds' then 'scheduled' else 'queued' end;
  update public.campaigns set status = v_status, start_at = v_start where id = c.id;

  perform public._log(uid, c.id, null, 'jobs_queued', format('%s individual sending jobs queued', v_queued),
                      jsonb_build_object('queued', v_queued, 'skipped', v_skipped));
  if v_status = 'scheduled' then
    perform public._log(uid, c.id, null, 'campaign_scheduled', format('Campaign "%s" scheduled for %s', c.name, v_start),
                        jsonb_build_object('start_at', v_start));
  end if;
  return jsonb_build_object('id', c.id, 'status', v_status, 'queued', v_queued, 'skipped', v_skipped, 'start_at', v_start);
end $$;

create or replace function public.pause_campaign(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := public._uid(); c public.campaigns;
begin
  update public.campaigns set status = 'paused', paused_at = now()
   where id = p_id and user_id = uid and status in ('scheduled','queued','running') returning * into c;
  if not found then raise exception 'campaign cannot be paused in its current state'; end if;
  perform public._log(uid, c.id, null, 'campaign_paused', format('Campaign "%s" paused', c.name), '{}');
  perform public._notify(uid, 'campaign_paused', 'Campaign paused', format('"%s" was paused.', c.name), c.id);
  return jsonb_build_object('id', c.id, 'status', 'paused');
end $$;

create or replace function public.resume_campaign(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := public._uid(); c public.campaigns; a public.connected_accounts; v_status text;
begin
  select * into c from public.campaigns where id = p_id and user_id = uid for update;
  if not found or c.status <> 'paused' then raise exception 'only paused campaigns can be resumed'; end if;
  select * into a from public.connected_accounts where id = c.account_id;
  if a is null or a.status <> 'active' then raise exception 'the Gmail account must be (re)connected before resuming'; end if;
  v_status := case
    when c.start_at is not null and c.start_at > now() then 'scheduled'
    when exists (select 1 from public.sending_jobs where campaign_id = c.id and status in ('submitted','claimed','sending','ambiguous')) then 'running'
    else 'queued' end;
  update public.campaigns set status = v_status, paused_at = null where id = c.id;
  perform public._log(uid, c.id, null, 'campaign_resumed', format('Campaign "%s" resumed', c.name), '{}');
  return jsonb_build_object('id', c.id, 'status', v_status);
end $$;

create or replace function public.cancel_campaign(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := public._uid(); c public.campaigns; n int;
begin
  update public.campaigns set status = 'cancelled' where id = p_id and user_id = uid
     and status in ('scheduled','queued','running','paused','completed') returning * into c;
  if not found then raise exception 'campaign cannot be cancelled in its current state'; end if;
  update public.sending_jobs set status = 'cancelled', last_error = 'campaign_cancelled', error_class = 'skipped', completed_at = now()
   where campaign_id = c.id and status = 'queued';
  get diagnostics n = row_count;
  update public.campaign_recipients set status = 'skipped', skip_reason = 'campaign_cancelled'
   where campaign_id = c.id and status in ('pending','queued');
  update public.campaign_recipients set followups_stopped = true, stop_reason = coalesce(stop_reason, 'campaign_cancelled')
   where campaign_id = c.id;
  perform public._log(uid, c.id, null, 'campaign_cancelled', format('Campaign "%s" cancelled (%s queued jobs cancelled)', c.name, n),
                      jsonb_build_object('cancelled_jobs', n));
  return jsonb_build_object('id', c.id, 'status', 'cancelled', 'cancelled_jobs', n);
end $$;

create or replace function public.delete_campaign(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := public._uid();
begin
  delete from public.campaigns where id = p_id and user_id = uid and status = 'draft';
  if not found then raise exception 'only draft campaigns can be deleted'; end if;
end $$;

create or replace function public.duplicate_campaign(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := public._uid(); c public.campaigns; nc public.campaigns; sq public.follow_up_sequences; nsq uuid;
begin
  select * into c from public.campaigns where id = p_id and user_id = uid;
  if not found then raise exception 'campaign not found'; end if;
  insert into public.campaigns(user_id, account_id, name, subject, body_html, body_text, template_id, delivery_mode, settings, attachments, follow_ups_enabled)
  values (uid, c.account_id, left(c.name || ' (copy)', 200), c.subject, c.body_html, c.body_text, c.template_id, c.delivery_mode, c.settings, c.attachments, c.follow_ups_enabled)
  returning * into nc;
  select * into sq from public.follow_up_sequences where campaign_id = c.id;
  if found then
    insert into public.follow_up_sequences(campaign_id, user_id, enabled) values (nc.id, uid, sq.enabled) returning id into nsq;
    insert into public.follow_up_steps(sequence_id, user_id, step_number, enabled, delay_minutes, condition, subject, body_html, body_text, reply_in_thread)
    select nsq, uid, step_number, enabled, delay_minutes, condition, subject, body_html, body_text, reply_in_thread
      from public.follow_up_steps where sequence_id = sq.id;
  end if;
  insert into public.campaign_recipients(campaign_id, user_id, contact_id, email, first_name, last_name, company, website, position, fields)
  select nc.id, uid, contact_id, email, first_name, last_name, company, website, position, fields
    from public.campaign_recipients where campaign_id = c.id;
  perform public._log(uid, nc.id, null, 'campaign_created', format('Campaign "%s" created (duplicate of "%s")', nc.name, c.name), '{}');
  return jsonb_build_object('id', nc.id);
end $$;

-- Manual kill switch for follow-ups (also cancels everything still queued).
create or replace function public.set_followups_enabled(p_id uuid, p_enabled boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := public._uid(); c public.campaigns; n int := 0;
begin
  update public.campaigns set follow_ups_enabled = p_enabled where id = p_id and user_id = uid returning * into c;
  if not found then raise exception 'campaign not found'; end if;
  if not p_enabled then
    update public.sending_jobs set status = 'cancelled', last_error = 'followups_disabled', error_class = 'skipped', completed_at = now()
     where campaign_id = c.id and step_number > 0 and status = 'queued';
    get diagnostics n = row_count;
    update public.campaign_recipients set followups_stopped = true, stop_reason = coalesce(stop_reason, 'manual')
     where campaign_id = c.id and not followups_stopped;
  end if;
  perform public._log(uid, c.id, null, 'followups_toggled',
                      format('Follow-ups %s for "%s"', case when p_enabled then 'enabled' else 'disabled' end, c.name), jsonb_build_object('cancelled', n));
  return jsonb_build_object('enabled', p_enabled, 'cancelled', n);
end $$;

-- Re-queue jobs that exhausted their retries (transient errors only; permanent failures stay failed).
create or replace function public.retry_failed_jobs(p_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare uid uuid := public._uid(); n int;
begin
  perform 1 from public.campaigns where id = p_id and user_id = uid;
  if not found then raise exception 'campaign not found'; end if;
  with up as (
    update public.sending_jobs set status = 'queued', attempts = 0, run_after = now(), completed_at = null, last_error = null, error_class = null
     where campaign_id = p_id and user_id = uid and status = 'failed' and error_class = 'transient_exhausted' returning recipient_id, step_number)
  update public.campaign_recipients r set status = 'queued', failure_reason = null
    from up where r.id = up.recipient_id and up.step_number = 0;
  get diagnostics n = row_count;
  update public.campaigns set status = 'queued', completed_at = null where id = p_id and status = 'completed' and n > 0;
  return n;
end $$;

------------------------------------------------------------------------------
-- reads
------------------------------------------------------------------------------
create or replace view public.campaign_stats with (security_invoker = true) as
select r.campaign_id, r.user_id,
       count(*)                                              as total,
       count(*) filter (where r.status = 'pending')           as pending,
       count(*) filter (where r.status = 'queued')            as queued,
       count(*) filter (where r.sent_at is not null)          as sent,
       count(*) filter (where r.status = 'drafted')           as drafted,
       count(*) filter (where r.open_count > 0)               as opened,
       count(*) filter (where r.click_count > 0)              as clicked,
       count(*) filter (where r.replied_at is not null)       as replied,
       count(*) filter (where r.status = 'bounced')           as bounced,
       count(*) filter (where r.status = 'unsubscribed')      as unsubscribed,
       count(*) filter (where r.status = 'failed')            as failed,
       count(*) filter (where r.status = 'skipped')           as skipped,
       coalesce(sum(r.follow_ups_sent), 0)::int               as follow_ups_sent
  from public.campaign_recipients r group by r.campaign_id, r.user_id;
grant select on public.campaign_stats to authenticated;

create or replace function public.list_campaigns(p_status text default null, p_search text default null, p_limit int default 50, p_offset int default 0)
returns jsonb language sql stable security invoker as $$
  with base as (
    select c.id, c.name, c.status, c.subject, c.delivery_mode, c.start_at, c.end_at, c.started_at, c.completed_at, c.created_at,
           c.follow_ups_enabled, c.settings, a.email as account_email,
           coalesce(s.total, 0) total, coalesce(s.pending, 0) pending, coalesce(s.queued, 0) queued, coalesce(s.sent, 0) sent,
           coalesce(s.opened, 0) opened, coalesce(s.clicked, 0) clicked, coalesce(s.replied, 0) replied,
           coalesce(s.bounced, 0) bounced, coalesce(s.unsubscribed, 0) unsubscribed, coalesce(s.failed, 0) failed,
           coalesce(s.skipped, 0) skipped, coalesce(s.follow_ups_sent, 0) follow_ups_sent
      from public.campaigns c
      left join public.campaign_stats s on s.campaign_id = c.id
      left join public.connected_accounts a on a.id = c.account_id
     where c.user_id = auth.uid()
       and (p_status is null or p_status = '' or c.status = p_status)
       and (p_search is null or p_search = '' or c.name ilike concat('%', p_search, '%'))),
  page as (select * from base order by created_at desc limit greatest(p_limit, 1) offset greatest(p_offset, 0))
  select jsonb_build_object('total', (select count(*) from base),
                            'rows', coalesce((select jsonb_agg(to_jsonb(page) order by page.created_at desc) from page), '[]'::jsonb))
$$;

create or replace function public.get_campaign(p_id uuid) returns jsonb
language sql stable security invoker as $$
  select to_jsonb(c)
         || jsonb_build_object(
              'account', (select jsonb_build_object('id', a.id, 'email', a.email, 'status', a.status, 'scopes', a.scopes)
                            from public.connected_accounts a where a.id = c.account_id),
              'stats', coalesce((select to_jsonb(s) - 'user_id' - 'campaign_id' from public.campaign_stats s where s.campaign_id = c.id),
                                '{"total":0,"pending":0,"queued":0,"sent":0,"drafted":0,"opened":0,"clicked":0,"replied":0,"bounced":0,"unsubscribed":0,"failed":0,"skipped":0,"follow_ups_sent":0}'::jsonb),
              'follow_ups', jsonb_build_object(
                  'enabled', coalesce((select q.enabled from public.follow_up_sequences q where q.campaign_id = c.id), true),
                  'steps', coalesce((select jsonb_agg(jsonb_build_object('step_number', fs.step_number, 'enabled', fs.enabled,
                              'delay_minutes', fs.delay_minutes, 'delay_days', round(fs.delay_minutes / 1440.0, 2), 'condition', fs.condition,
                              'subject', fs.subject, 'body_html', fs.body_html, 'body_text', fs.body_text, 'reply_in_thread', fs.reply_in_thread)
                              order by fs.step_number)
                            from public.follow_up_steps fs join public.follow_up_sequences q on q.id = fs.sequence_id
                           where q.campaign_id = c.id), '[]'::jsonb)),
              'jobs', jsonb_build_object(
                  'queued', (select count(*) from public.sending_jobs j where j.campaign_id = c.id and j.status = 'queued' and j.step_number = 0),
                  'followups_queued', (select count(*) from public.sending_jobs j where j.campaign_id = c.id and j.status = 'queued' and j.step_number > 0),
                  'ambiguous', (select count(*) from public.sending_jobs j where j.campaign_id = c.id and j.status = 'ambiguous'),
                  'failed', (select count(*) from public.sending_jobs j where j.campaign_id = c.id and j.status = 'failed'),
                  'next_run_at', (select min(j.run_after) from public.sending_jobs j where j.campaign_id = c.id and j.status = 'queued')))
    from public.campaigns c where c.id = p_id and c.user_id = auth.uid()
$$;

create or replace function public.list_campaign_recipients(
  p_campaign uuid, p_filter text default 'all', p_search text default null, p_sort text default 'created_at',
  p_dir text default 'asc', p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security invoker as $$
declare v_where text; v_sort text; v_dir text; v_total int; v_rows jsonb;
begin
  v_where := case coalesce(p_filter, 'all')
    when 'all' then 'true'
    when 'pending' then 'r.status = ''pending'''
    when 'queued' then 'r.status = ''queued'''
    when 'sent' then 'r.sent_at is not null'
    when 'opened' then 'r.open_count > 0'
    when 'not_opened' then 'r.sent_at is not null and r.open_count = 0'
    when 'clicked' then 'r.click_count > 0'
    when 'replied' then 'r.replied_at is not null'
    when 'no_reply' then 'r.sent_at is not null and r.replied_at is null'
    when 'bounced' then 'r.status = ''bounced'''
    when 'unsubscribed' then 'r.status = ''unsubscribed'''
    when 'failed' then 'r.status = ''failed'''
    when 'skipped' then 'r.status = ''skipped'''
    else null end;
  if v_where is null then raise exception 'unknown filter %', p_filter; end if;
  v_sort := case when p_sort in ('email','status','sent_at','open_count','click_count','replied_at','created_at','last_opened_at','follow_ups_sent')
                 then p_sort else 'created_at' end;
  v_dir := case when lower(coalesce(p_dir, 'asc')) = 'desc' then 'desc' else 'asc' end;

  execute format($q$select count(*) from public.campaign_recipients r
      where r.campaign_id = $1 and r.user_id = auth.uid() and (%s)
        and ($2 is null or $2 = '' or r.email ilike concat('%%', $2, '%%') or coalesce(r.first_name, '') ilike concat('%%', $2, '%%')
             or coalesce(r.last_name, '') ilike concat('%%', $2, '%%') or coalesce(r.company, '') ilike concat('%%', $2, '%%'))$q$, v_where)
    into v_total using p_campaign, p_search;

  execute format($q$select coalesce(jsonb_agg(to_jsonb(t) order by t.rn), '[]'::jsonb) from (
      select row_number() over (order by r.%I %s nulls last, r.id) as rn,
             r.id, r.email, r.first_name, r.last_name, r.company, r.status, r.sent_at, r.open_count, r.opened_at, r.last_opened_at,
             r.click_count, r.replied_at, r.reply_preview, r.follow_ups_sent, r.failure_reason, r.skip_reason, r.stop_reason, r.followups_stopped,
             (select min(j.run_after) from public.sending_jobs j where j.recipient_id = r.id and j.status = 'queued' and j.step_number > 0) as next_followup_at
        from public.campaign_recipients r
       where r.campaign_id = $1 and r.user_id = auth.uid() and (%s)
         and ($2 is null or $2 = '' or r.email ilike concat('%%', $2, '%%') or coalesce(r.first_name, '') ilike concat('%%', $2, '%%')
              or coalesce(r.last_name, '') ilike concat('%%', $2, '%%') or coalesce(r.company, '') ilike concat('%%', $2, '%%'))
       order by r.%I %s nulls last, r.id
       limit $3 offset $4) t$q$, v_sort, v_dir, v_where, v_sort, v_dir)
    into v_rows using p_campaign, p_search, greatest(p_limit, 1), greatest(p_offset, 0);
  return jsonb_build_object('total', v_total, 'rows', v_rows);
end $$;

create or replace function public.recipient_detail(p_recipient uuid) returns jsonb
language sql stable security invoker as $$
  select jsonb_build_object(
    'recipient', to_jsonb(r) - 'user_id' - 'token',
    'messages', coalesce((select jsonb_agg(to_jsonb(m) - 'user_id' order by m.sent_at) from public.email_messages m where m.recipient_id = r.id), '[]'),
    'jobs', coalesce((select jsonb_agg(jsonb_build_object('id', j.id, 'step_number', j.step_number, 'status', j.status, 'run_after', j.run_after,
                       'attempts', j.attempts, 'error_class', j.error_class, 'last_error', j.last_error) order by j.step_number)
                       from public.sending_jobs j where j.recipient_id = r.id), '[]'),
    'events', coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at desc)
                          from (select event_type, url, counted, created_at from public.tracking_events where recipient_id = r.id
                                order by created_at desc limit 50) e), '[]'),
    'replies', coalesce((select jsonb_agg(jsonb_build_object('from', x.from_email, 'snippet', x.snippet, 'received_at', x.received_at) order by x.received_at)
                           from public.replies x where x.recipient_id = r.id), '[]'),
    'bounces', coalesce((select jsonb_agg(jsonb_build_object('type', b.bounce_type, 'reason', b.reason, 'detected_at', b.detected_at))
                           from public.bounces b where b.recipient_id = r.id), '[]'),
    'activity', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at desc)
                            from (select event_type, message, created_at from public.activity_logs where recipient_id = r.id
                                  order by created_at desc limit 50) a), '[]'))
    from public.campaign_recipients r where r.id = p_recipient and r.user_id = auth.uid()
$$;

------------------------------------------------------------------------------
-- dashboard overview (all numbers computed from tables, nothing hard-coded)
------------------------------------------------------------------------------
create or replace function public.overview_stats() returns jsonb
language plpgsql stable security invoker as $$
declare
  uid uuid := public._uid();
  tz text := public.safe_tz((select timezone from public.user_settings where user_id = uid));
  v jsonb; t record;
begin
  select coalesce(sum(total), 0) total, coalesce(sum(pending + queued), 0) pending, coalesce(sum(sent), 0) sent,
         coalesce(sum(opened), 0) opened, coalesce(sum(clicked), 0) clicked, coalesce(sum(replied), 0) replied,
         coalesce(sum(bounced), 0) bounced, coalesce(sum(failed), 0) failed, coalesce(sum(skipped), 0) skipped,
         coalesce(sum(unsubscribed), 0) unsubscribed
    into t from public.campaign_stats where user_id = uid;
  v := jsonb_build_object(
    'totals', jsonb_build_object(
        'campaigns', (select count(*) from public.campaigns where user_id = uid),
        'recipients', t.total, 'sent', t.sent, 'pending', t.pending, 'opened', t.opened, 'clicked', t.clicked, 'replied', t.replied,
        'bounced', t.bounced, 'failed', t.failed, 'skipped', t.skipped, 'unsubscribed', t.unsubscribed,
        'contacts', (select count(*) from public.contacts where user_id = uid),
        'suppressed', (select count(*) from public.suppression_entries where user_id = uid)),
    'rates', jsonb_build_object(
        'open_rate', case when t.sent > 0 then round(t.opened * 100.0 / t.sent, 1) end,
        'click_rate', case when t.sent > 0 then round(t.clicked * 100.0 / t.sent, 1) end,
        'reply_rate', case when t.sent > 0 then round(t.replied * 100.0 / t.sent, 1) end,
        'bounce_rate', case when t.sent > 0 then round(t.bounced * 100.0 / t.sent, 1) end));

  v := v || jsonb_build_object('daily', (
    select coalesce(jsonb_agg(jsonb_build_object('date', d.day, 'sent', coalesce(s.n, 0), 'opened', coalesce(o.n, 0), 'replied', coalesce(r.n, 0)) order by d.day), '[]')
      from (select ((now() at time zone tz)::date - g) as day from generate_series(0, 29) g) d
      left join (select (sent_at at time zone tz)::date as day, count(*) as n from public.email_messages
                  where user_id = uid and kind = 'sent' and sent_at > now() - interval '31 days' group by 1) s on s.day = d.day
      left join (select (opened_at at time zone tz)::date as day, count(*) as n from public.campaign_recipients
                  where user_id = uid and opened_at > now() - interval '31 days' group by 1) o on o.day = d.day
      left join (select (received_at at time zone tz)::date as day, count(*) as n from public.replies
                  where user_id = uid and received_at > now() - interval '31 days' group by 1) r on r.day = d.day));

  v := v || jsonb_build_object('campaign_performance', (
    select coalesce(jsonb_agg(x order by x.created_at), '[]') from (
      select c.name, c.created_at, coalesce(s.sent, 0) sent, coalesce(s.opened, 0) opened, coalesce(s.replied, 0) replied, coalesce(s.bounced, 0) bounced
        from public.campaigns c left join public.campaign_stats s on s.campaign_id = c.id
       where c.user_id = uid and c.status <> 'draft' order by c.created_at desc limit 8) x));

  v := v || jsonb_build_object('recent_activity', (
    select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]') from (
      select a.id, a.event_type, a.message, a.created_at, c.name as campaign_name
        from public.activity_logs a left join public.campaigns c on c.id = a.campaign_id
       where a.user_id = uid and a.event_type not like 'audit.%' order by a.created_at desc limit 10) x));

  v := v || jsonb_build_object('recent_replies', (
    select coalesce(jsonb_agg(to_jsonb(x) order by x.received_at desc), '[]') from (
      select rp.id, rp.from_email, rp.snippet, rp.received_at, c.name as campaign_name, c.id as campaign_id
        from public.replies rp join public.campaigns c on c.id = rp.campaign_id
       where rp.user_id = uid order by rp.received_at desc limit 5) x));

  v := v || jsonb_build_object('upcoming', (
    select coalesce(jsonb_agg(to_jsonb(x) order by x.start_at), '[]') from (
      select c.id, c.name, c.status, c.start_at, coalesce(s.total, 0) recipients
        from public.campaigns c left join public.campaign_stats s on s.campaign_id = c.id
       where c.user_id = uid and c.status in ('scheduled','queued') order by c.start_at limit 5) x));

  v := v || jsonb_build_object('failed_jobs', (
    select coalesce(jsonb_agg(to_jsonb(x) order by x.updated_at desc), '[]') from (
      select j.id, j.status, j.error_class, j.last_error, j.updated_at, j.campaign_id, c.name as campaign_name, r.email
        from public.sending_jobs j join public.campaign_recipients r on r.id = j.recipient_id join public.campaigns c on c.id = j.campaign_id
       where j.user_id = uid and j.status in ('failed','ambiguous') order by j.updated_at desc limit 10) x));
  return v;
end $$;

create or replace function public.analytics_overview(p_days int default 30) returns jsonb
language plpgsql stable security invoker as $$
declare
  uid uuid := public._uid();
  tz text := public.safe_tz((select timezone from public.user_settings where user_id = uid));
  n int := least(greatest(coalesce(p_days, 30), 1), 180);
begin
  return jsonb_build_object(
    'days', n,
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('date', d.day, 'sent', coalesce(s.n, 0), 'opened', coalesce(o.n, 0),
                      'clicked', coalesce(k.n, 0), 'replied', coalesce(r.n, 0), 'bounced', coalesce(b.n, 0)) order by d.day), '[]')
        from (select ((now() at time zone tz)::date - g) as day from generate_series(0, n - 1) g) d
        left join (select (sent_at at time zone tz)::date as day, count(*) as n from public.email_messages
                    where user_id = uid and kind = 'sent' and sent_at > now() - make_interval(days => n + 1) group by 1) s on s.day = d.day
        left join (select (created_at at time zone tz)::date as day, count(*) as n from public.tracking_events
                    where user_id = uid and event_type = 'open' and counted and created_at > now() - make_interval(days => n + 1) group by 1) o on o.day = d.day
        left join (select (created_at at time zone tz)::date as day, count(*) as n from public.tracking_events
                    where user_id = uid and event_type = 'click' and counted and created_at > now() - make_interval(days => n + 1) group by 1) k on k.day = d.day
        left join (select (received_at at time zone tz)::date as day, count(*) as n from public.replies
                    where user_id = uid and received_at > now() - make_interval(days => n + 1) group by 1) r on r.day = d.day
        left join (select (detected_at at time zone tz)::date as day, count(*) as n from public.bounces
                    where user_id = uid and bounce_type = 'permanent' and detected_at > now() - make_interval(days => n + 1) group by 1) b on b.day = d.day),
    'top_links', (select coalesce(jsonb_agg(x), '[]') from (
        select url, count(*) clicks, count(distinct recipient_id) unique_clickers from public.tracking_events
         where user_id = uid and event_type = 'click' and counted and created_at > now() - make_interval(days => n)
         group by url order by count(*) desc limit 10) x),
    'by_campaign', (select coalesce(jsonb_agg(x order by x.sent desc), '[]') from (
        select c.id, c.name, coalesce(s.sent, 0) sent, coalesce(s.opened, 0) opened, coalesce(s.clicked, 0) clicked,
               coalesce(s.replied, 0) replied, coalesce(s.bounced, 0) bounced
          from public.campaigns c left join public.campaign_stats s on s.campaign_id = c.id
         where c.user_id = uid and c.status <> 'draft' order by c.created_at desc limit 20) x));
end $$;

------------------------------------------------------------------------------
-- contacts
------------------------------------------------------------------------------
create or replace function public.import_contacts(p_rows jsonb, p_group uuid default null, p_consent_source text default 'import')
returns jsonb language plpgsql security invoker as $$
declare uid uuid := public._uid(); v_ins int; v_upd int; v_invalid int; v_dups int; v_ids uuid[];
begin
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'rows must be an array'; end if;
  if jsonb_array_length(p_rows) > 10000 then raise exception 'at most 10000 contacts per import'; end if;
  if p_group is not null and not exists (select 1 from public.contact_groups where id = p_group and user_id = uid) then
    raise exception 'group not found';
  end if;
  with raw as (
    select t.ord, lower(btrim(t.e ->> 'email')) email, t.e from jsonb_array_elements(p_rows) with ordinality t(e, ord)),
  chk as (select raw.*, public._valid_email(email) ok, row_number() over (partition by email order by ord) rn from raw),
  ups as (
    insert into public.contacts as ct(user_id, email, first_name, last_name, company, website, position, custom_fields, tags, consent_source, consent_at)
    select uid, email, left(nullif(btrim(e ->> 'first_name'), ''), 200), left(nullif(btrim(e ->> 'last_name'), ''), 200),
           left(nullif(btrim(e ->> 'company'), ''), 300), left(nullif(btrim(e ->> 'website'), ''), 300), left(nullif(btrim(e ->> 'position'), ''), 300),
           case when jsonb_typeof(e -> 'fields') = 'object' then e -> 'fields' else '{}'::jsonb end,
           coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(e -> 'tags') = 'array' then e -> 'tags' else '[]'::jsonb end)), '{}'),
           left(p_consent_source, 200), now()
      from chk where ok and rn = 1
    on conflict (user_id, email) do update set
      first_name = coalesce(excluded.first_name, ct.first_name), last_name = coalesce(excluded.last_name, ct.last_name),
      company = coalesce(excluded.company, ct.company), website = coalesce(excluded.website, ct.website),
      position = coalesce(excluded.position, ct.position), custom_fields = ct.custom_fields || excluded.custom_fields,
      tags = (select coalesce(array_agg(distinct x), '{}') from unnest(ct.tags || excluded.tags) x)
    returning ct.id, (xmax = 0) as inserted),
  agg as (select ups.id, ups.inserted from ups)
  select count(*) filter (where inserted), count(*) filter (where not inserted),
         (select count(*) from chk where not ok), (select count(*) from chk where ok and rn > 1), coalesce(array_agg(id), '{}')
    into v_ins, v_upd, v_invalid, v_dups, v_ids from agg;
  -- separate statement: the RLS check on group membership must be able to see the contacts just written
  if p_group is not null and cardinality(v_ids) > 0 then
    insert into public.contact_group_members(group_id, contact_id) select p_group, x from unnest(v_ids) x on conflict do nothing;
  end if;
  return jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'invalid', v_invalid, 'duplicates', v_dups);
end $$;

create or replace function public.group_contacts(p_group uuid) returns setof public.contacts
language sql stable security invoker as $$
  select c.* from public.contacts c join public.contact_groups g on g.id = p_group and g.user_id = c.user_id
   where c.user_id = auth.uid() and (
     (not g.is_segment and exists (select 1 from public.contact_group_members m where m.group_id = g.id and m.contact_id = c.id))
     or (g.is_segment
         and (coalesce(jsonb_array_length(g.segment_filter -> 'tags'), 0) = 0
              or c.tags && array(select jsonb_array_elements_text(g.segment_filter -> 'tags')))
         and (coalesce(g.segment_filter ->> 'company', '') = '' or c.company ilike concat('%', g.segment_filter ->> 'company', '%'))
         and (coalesce(g.segment_filter ->> 'status', '') = '' or c.subscription_status = g.segment_filter ->> 'status')))
$$;

create or replace function public.export_my_data() returns jsonb
language plpgsql stable security invoker as $$
declare uid uuid := public._uid();
begin
  return jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) from public.profiles p where p.id = uid),
    'settings', (select to_jsonb(s) from public.user_settings s where s.user_id = uid),
    'connected_accounts', (select coalesce(jsonb_agg(to_jsonb(a)), '[]') from public.connected_accounts a where a.user_id = uid),
    'contacts', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.contacts x where x.user_id = uid),
    'contact_groups', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.contact_groups x where x.user_id = uid),
    'templates', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.email_templates x where x.user_id = uid),
    'campaigns', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.campaigns x where x.user_id = uid),
    'campaign_recipients', (select coalesce(jsonb_agg(to_jsonb(x) - 'token'), '[]') from public.campaign_recipients x where x.user_id = uid),
    'email_messages', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.email_messages x where x.user_id = uid),
    'tracking_events', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.tracking_events x where x.user_id = uid),
    'replies', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.replies x where x.user_id = uid),
    'bounces', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.bounces x where x.user_id = uid),
    'suppression_entries', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.suppression_entries x where x.user_id = uid),
    'unsubscribe_events', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.unsubscribe_events x where x.user_id = uid),
    'activity_logs', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (select * from public.activity_logs where user_id = uid order by created_at desc limit 10000) x));
end $$;

------------------------------------------------------------------------------
-- starter templates (legitimate professional outreach)
------------------------------------------------------------------------------
create or replace function public.seed_starter_templates(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.email_templates(user_id, name, category, subject, body_html, is_starter) values
  (p_user, 'Introduction & partnership', 'Outreach', 'Idea for {{Company}}',
   '<p>Hi {{FirstName|there}},</p><p>I came across {{Company}} ({{Website}}) and thought there might be a good fit for us to work together. I help teams like yours with [what you do].</p><p>Would you be open to a quick 15-minute call next week?</p><p>Best,<br>[Your name]</p>', true),
  (p_user, 'Guest post pitch', 'Content', 'Guest post idea for {{Company}}',
   '<p>Hi {{FirstName|there}},</p><p>I enjoy reading {{Website}}. I would love to contribute an original article for your audience. A few topics I could cover:</p><ul><li>[Topic 1]</li><li>[Topic 2]</li><li>[Topic 3]</li></ul><p>Happy to share a full outline if any of them interest you.</p><p>Thanks,<br>[Your name]</p>', true),
  (p_user, 'Meeting request', 'Sales', 'Quick chat, {{FirstName|there}}?',
   '<p>Hi {{FirstName|there}},</p><p>As {{Position|a leader}} at {{Company}}, you are probably thinking about [challenge]. We recently helped a similar team achieve [result].</p><p>Do you have 15 minutes this week or next to compare notes?</p><p>Regards,<br>[Your name]</p>', true),
  (p_user, 'Gentle follow-up', 'Follow-up', 'Re: following up',
   '<p>Hi {{FirstName|there}},</p><p>I wanted to follow up on my previous note in case it slipped through. If now is not a good time, just let me know and I will check back later.</p><p>Thanks,<br>[Your name]</p>', true),
  (p_user, 'Event invitation', 'Events', 'You are invited: [Event name]',
   '<p>Hi {{FirstName|there}},</p><p>We are hosting [Event name] on [date] and would love to see you and the {{Company}} team there. It is a chance to [benefit].</p><p><a href="https://example.com/register">Reserve your spot</a></p><p>Hope to see you,<br>[Your name]</p>', true),
  (p_user, 'Thank you after a meeting', 'Relationship', 'Thanks for your time, {{FirstName|there}}',
   '<p>Hi {{FirstName|there}},</p><p>Thank you for taking the time to speak with me today. As discussed, my next steps are:</p><ul><li>[Action 1]</li><li>[Action 2]</li></ul><p>Let me know if I missed anything.</p><p>Best,<br>[Your name]</p>', true);
end $$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name') on conflict (id) do nothing;
  insert into public.user_settings(user_id) values (new.id) on conflict do nothing;
  perform public.seed_starter_templates(new.id);
  return new;
end $$;
