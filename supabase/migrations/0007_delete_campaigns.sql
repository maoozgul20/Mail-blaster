-- MailBlaster AI :: 0007 allow deleting finished campaigns (not only drafts)
-- A running / queued / scheduled / paused campaign must be cancelled first, so nothing in flight is removed by accident.
-- Deleting a campaign also removes its recipients, queued follow-ups, tracking events and activity (cascade).
-- Suppression and unsubscribe entries are kept on purpose so those people are never emailed again.

create or replace function public.delete_campaign(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := public._uid();
begin
  delete from public.campaigns
   where id = p_id and user_id = uid and status in ('draft', 'completed', 'cancelled', 'failed');
  if not found then
    raise exception 'only draft, completed, cancelled or failed campaigns can be deleted (cancel a running campaign first)';
  end if;
end $$;
