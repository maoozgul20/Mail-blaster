-- MailBlaster AI :: 0006 function permissions, storage bucket, realtime
-- Default: nothing is callable by client roles. User-facing functions are granted to `authenticated`.
-- Internal functions (wk_*, _log, _skip_job, ...) are callable by the service role (Worker) ONLY.

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

grant execute on function
  public.save_campaign(uuid, jsonb),
  public.start_campaign(uuid, timestamptz),
  public.pause_campaign(uuid),
  public.resume_campaign(uuid),
  public.cancel_campaign(uuid),
  public.delete_campaign(uuid),
  public.duplicate_campaign(uuid),
  public.set_followups_enabled(uuid, boolean),
  public.retry_failed_jobs(uuid),
  public.resolve_job(uuid, text),
  public.list_campaigns(text, text, int, int),
  public.get_campaign(uuid),
  public.list_campaign_recipients(uuid, text, text, text, text, int, int),
  public.recipient_detail(uuid),
  public.overview_stats(),
  public.analytics_overview(int),
  public.import_contacts(jsonb, uuid, text),
  public.group_contacts(uuid),
  public.export_my_data(),
  public.check_suppressed(text[]),
  public._uid(),
  public._valid_email(text),
  public.safe_tz(text)
to authenticated;

-- Private bucket for attachments; no policies => only the service role (Worker) can read/write.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('attachments', 'attachments', false, 2097152) on conflict (id) do nothing;
  end if;
end $$;

-- Realtime: live campaign progress in the dashboard (RLS still applies to subscribers)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.campaigns; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.campaign_recipients; exception when duplicate_object then null; end;
  end if;
end $$;
