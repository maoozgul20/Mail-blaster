-- MailBlaster AI :: 0002 Row Level Security + grants
-- Principle: authenticated users can READ their own rows everywhere and WRITE only user-managed
-- data (contacts, groups, templates, suppression list, settings). Anything that drives the
-- queue (campaigns, recipients, jobs, events) is only written through SECURITY DEFINER functions.
-- oauth_tokens and rate_limits have RLS enabled and no policies => service_role only.

do $$
declare t text;
begin
  foreach t in array array[
    'profiles','user_settings','connected_accounts','oauth_tokens','contacts','contact_groups',
    'contact_group_members','email_templates','campaigns','campaign_recipients','follow_up_sequences',
    'follow_up_steps','sending_jobs','email_messages','tracking_events','replies','bounces',
    'suppression_entries','unsubscribe_events','activity_logs','notifications','rate_limits']
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- Start from zero privileges for client roles, then grant explicitly.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- owner-select policies (tables with user_id)
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','user_settings','connected_accounts','contacts','contact_groups','email_templates',
    'campaigns','campaign_recipients','follow_up_sequences','follow_up_steps','sending_jobs',
    'email_messages','tracking_events','replies','bounces','suppression_entries','unsubscribe_events',
    'activity_logs','notifications']
  loop
    if t = 'profiles' then
      execute 'create policy "own rows select" on public.profiles for select to authenticated using (id = (select auth.uid()))';
    else
      execute format('create policy "own rows select" on public.%I for select to authenticated using (user_id = (select auth.uid()))', t);
    end if;
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- user-managed tables: full CRUD on own rows
do $$
declare t text;
begin
  foreach t in array array['contacts','contact_groups','email_templates','suppression_entries']
  loop
    execute format('create policy "own rows insert" on public.%I for insert to authenticated with check (user_id = (select auth.uid()))', t);
    execute format('create policy "own rows update" on public.%I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
    execute format('create policy "own rows delete" on public.%I for delete to authenticated using (user_id = (select auth.uid()))', t);
    execute format('grant insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- contact_group_members: ownership flows through the parent group AND the contact
create policy "members select" on public.contact_group_members for select to authenticated
  using (exists (select 1 from public.contact_groups g where g.id = group_id and g.user_id = (select auth.uid())));
create policy "members insert" on public.contact_group_members for insert to authenticated
  with check (
    exists (select 1 from public.contact_groups g where g.id = group_id and g.user_id = (select auth.uid()))
    and exists (select 1 from public.contacts c where c.id = contact_id and c.user_id = (select auth.uid())));
create policy "members delete" on public.contact_group_members for delete to authenticated
  using (exists (select 1 from public.contact_groups g where g.id = group_id and g.user_id = (select auth.uid())));
grant select, insert, delete on public.contact_group_members to authenticated;

-- settings / profile: update only
create policy "own settings update" on public.user_settings for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant update on public.user_settings to authenticated;

create policy "own profile update" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
grant update (full_name) on public.profiles to authenticated;

-- notifications: mark as read / delete
create policy "own notifications update" on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own notifications delete" on public.notifications for delete to authenticated
  using (user_id = (select auth.uid()));
grant update (read_at), delete on public.notifications to authenticated;

-- connected_accounts: users may only tune non-security settings; everything else is Worker-managed
create policy "own accounts update" on public.connected_accounts for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant update (max_concurrent) on public.connected_accounts to authenticated;

-- service role (Worker) gets everything; it has BYPASSRLS on Supabase.
grant all on all tables in schema public to service_role;
grant usage on schema public to anon, authenticated, service_role;

-- Guard: contact owner must also own the account/contacts referenced (defence in depth)
create or replace function public.guard_campaign_account() returns trigger
language plpgsql as $$
begin
  if new.account_id is not null and not exists (
    select 1 from public.connected_accounts a where a.id = new.account_id and a.user_id = new.user_id) then
    raise exception 'account does not belong to campaign owner';
  end if;
  return new;
end $$;
create trigger campaigns_guard_account before insert or update of account_id on public.campaigns
for each row execute function public.guard_campaign_account();
