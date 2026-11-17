import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Activity as ActivityIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge, Card, EmptyState, PageHeader, Pagination, Select, Skeleton, Table, TBody, TD, TH, THead, TR } from '@/components/ui';
import { fmtDate } from '@/lib/utils';

const TYPES: [string, string, any][] = [
  ['campaign_created', 'Campaign created', 'indigo'], ['campaign_scheduled', 'Campaign scheduled', 'blue'], ['jobs_queued', 'Jobs queued', 'indigo'], ['campaign_started', 'Campaign started', 'green'],
  ['email_submitted', 'Email submitted', 'blue'], ['email_opened', 'Email opened', 'green'], ['link_clicked', 'Link clicked', 'green'], ['reply_received', 'Reply received', 'violet'],
  ['followup_scheduled', 'Follow-up scheduled', 'indigo'], ['followup_submitted', 'Follow-up submitted', 'blue'], ['followup_cancelled', 'Follow-up cancelled', 'neutral'], ['bounce_detected', 'Bounce detected', 'red'],
  ['job_failed', 'Failed job', 'red'], ['job_retry_scheduled', 'Retry scheduled', 'amber'], ['job_ambiguous', 'Unknown outcome', 'amber'], ['job_skipped', 'Email skipped', 'neutral'],
  ['campaign_paused', 'Campaign paused', 'amber'], ['campaign_resumed', 'Campaign resumed', 'green'], ['campaign_cancelled', 'Campaign cancelled', 'neutral'], ['campaign_completed', 'Campaign completed', 'violet'],
  ['unsubscribed', 'Unsubscribed', 'amber'], ['daily_limit_reached', 'Daily limit reached', 'amber'], ['quota_exceeded', 'Gmail quota reached', 'red'], ['account_reauth_required', 'Reauthorization needed', 'amber'], ['draft_created', 'Draft created', 'violet'],
];
const meta = Object.fromEntries(TYPES.map(([k, l, t]) => [k, { l, t }]));
const LIMIT = 50;

export default function Activity() {
  const [type, setType] = React.useState(''); const [offset, setOffset] = React.useState(0);
  const q = useQuery({ queryKey: ['activity', type, offset], queryFn: () => api.activity({ type, limit: LIMIT, offset }), refetchInterval: 15_000, placeholderData: (p) => p });
  return (
    <>
      <PageHeader title="Activity" description="A timestamped log of everything MailBlaster did on your behalf." actions={<Select className="w-52" value={type} onChange={(e) => { setType(e.target.value); setOffset(0); }} aria-label="Event type"><option value="">All events</option>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>} />
      <Card>
        {q.isLoading ? <div className="p-4"><Skeleton className="h-48" /></div> : q.data?.rows.length === 0 ? <EmptyState icon={<ActivityIcon className="h-5 w-5" />} title="No activity yet" /> : (
          <Table><THead><TR><TH>Time</TH><TH>Event</TH><TH>Recipient</TH><TH>Campaign</TH><TH>Details</TH></TR></THead>
            <TBody>{q.data?.rows.map((a: any) => (<TR key={a.id}><TD className="whitespace-nowrap text-xs text-muted-foreground">{fmtDate(a.created_at)}</TD><TD><Badge tone={meta[a.event_type]?.t ?? 'neutral'}>{meta[a.event_type]?.l ?? a.event_type.replace(/_/g, ' ')}</Badge></TD>
              <TD className="text-sm">{a.recipient_email ?? '—'}</TD><TD>{a.campaign_id ? <Link className="hover:underline" to={`/campaigns/${a.campaign_id}`}>{a.campaign_name ?? 'Campaign'}</Link> : '—'}</TD><TD className="max-w-md text-sm text-muted-foreground">{a.message}</TD></TR>))}</TBody></Table>)}
        {q.data && q.data.total > 0 && <Pagination total={q.data.total} limit={LIMIT} offset={offset} onChange={setOffset} />}
      </Card>
    </>
  );
}
