import * as React from 'react';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { useQueryClient } from '@tanstack/react-query';
import { readSession } from './api';

const URL_ = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
let client: SupabaseClient | null = null;

/** Live progress through Supabase Realtime (RLS-protected). Returns whether the socket is connected; callers poll when it is not. */
export function useLiveCampaign(campaignId: string | undefined): boolean {
  const qc = useQueryClient();
  const [live, setLive] = React.useState(false);
  React.useEffect(() => {
    const s = readSession();
    if (!campaignId || !URL_ || !KEY || !s) return;
    client ??= createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    client.realtime.setAuth(s.access_token);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        qc.invalidateQueries({ queryKey: ['campaign', campaignId] });
        qc.invalidateQueries({ queryKey: ['recipients', campaignId] });
      }, 600);
    };
    const ch = client
      .channel(`campaign-${campaignId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'campaigns', filter: `id=eq.${campaignId}` }, bump)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'campaign_recipients', filter: `campaign_id=eq.${campaignId}` }, bump)
      .subscribe((status) => setLive(status === 'SUBSCRIBED'));
    return () => { clearTimeout(timer); setLive(false); client?.removeChannel(ch); };
  }, [campaignId, qc]);
  return live;
}
