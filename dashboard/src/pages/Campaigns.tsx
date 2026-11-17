import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, ExternalLink, Pause, Pencil, Play, PlusCircle, Search, Trash2, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { Button, Card, EmptyState, Input, PageHeader, Pagination, Progress, Skeleton, Table, TBody, TD, TH, THead, TR } from '@/components/ui';
import { StatusBadge } from '@/components/StatusBadge';
import { errMsg, useToast } from '@/components/toast';
import { downloadBlob, fmtDate, fmtNum } from '@/lib/utils';
import type { CampaignRow } from '@mailblaster/shared';

const STATUSES = ['', 'draft', 'scheduled', 'queued', 'running', 'paused', 'completed', 'cancelled', 'failed'];
const LIMIT = 25;

export function useCampaignActions() {
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const refresh = () => { qc.invalidateQueries({ queryKey: ['campaigns'] }); qc.invalidateQueries({ queryKey: ['campaign'] }); qc.invalidateQueries({ queryKey: ['overview'] }); };
  const run = async (label: string, fn: () => Promise<unknown>, after?: (r: any) => void) => {
    try { const r = await fn(); toast.success(label); refresh(); after?.(r); } catch (e) { toast.error(errMsg(e)); }
  };
  return {
    pause: (id: string) => run('Campaign paused', () => api.campaignAction(id, 'pause')),
    resume: (id: string) => run('Campaign resumed', () => api.campaignAction(id, 'resume')),
    cancel: (id: string) => { if (confirm('Cancel this campaign? Queued emails and follow-ups will be dropped. Emails already sent cannot be recalled.')) return run('Campaign cancelled', () => api.campaignAction(id, 'cancel')); },
    duplicate: (id: string) => run('Duplicated as a new draft', () => api.campaignAction(id, 'duplicate'), (r) => nav(`/campaigns/${r.id}/edit`)),
    remove: (id: string) => { if (confirm('Delete this draft?')) return run('Draft deleted', () => api.deleteCampaign(id)); },
    exportCsv: async (id: string, name: string) => { try { downloadBlob(await api.downloadCsv(`/api/campaigns/${id}/export.csv`), `${name.replace(/[^\w-]+/g, '_')}-recipients.csv`); } catch (e) { toast.error(errMsg(e)); } },
  };
}

export function CampaignActions({ c }: { c: Pick<CampaignRow, 'id' | 'status' | 'name'> }) {
  const a = useCampaignActions();
  const canPause = ['scheduled', 'queued', 'running'].includes(c.status);
  const canCancel = ['scheduled', 'queued', 'running', 'paused', 'completed'].includes(c.status);
  return (
    <div className="flex items-center justify-end gap-0.5">
      <Button asChild variant="ghost" size="icon" title="Open" aria-label="Open"><Link to={`/campaigns/${c.id}`}><ExternalLink className="h-4 w-4" /></Link></Button>
      {c.status === 'draft' && <Button asChild variant="ghost" size="icon" title="Edit" aria-label="Edit"><Link to={`/campaigns/${c.id}/edit`}><Pencil className="h-4 w-4" /></Link></Button>}
      {canPause && <Button variant="ghost" size="icon" title="Pause" aria-label="Pause" onClick={() => a.pause(c.id)}><Pause className="h-4 w-4" /></Button>}
      {c.status === 'paused' && <Button variant="ghost" size="icon" title="Resume" aria-label="Resume" onClick={() => a.resume(c.id)}><Play className="h-4 w-4" /></Button>}
      <Button variant="ghost" size="icon" title="Duplicate" aria-label="Duplicate" onClick={() => a.duplicate(c.id)}><Copy className="h-4 w-4" /></Button>
      {canCancel && <Button variant="ghost" size="icon" title="Cancel" aria-label="Cancel" onClick={() => a.cancel(c.id)}><XCircle className="h-4 w-4 text-amber-400" /></Button>}
      {c.status === 'draft' && <Button variant="ghost" size="icon" title="Delete draft" aria-label="Delete draft" onClick={() => a.remove(c.id)}><Trash2 className="h-4 w-4 text-rose-400" /></Button>}
      <Button variant="ghost" size="icon" title="Export CSV" aria-label="Export CSV" onClick={() => a.exportCsv(c.id, c.name)}><Download className="h-4 w-4" /></Button>
    </div>
  );
}

export default function Campaigns() {
  const [status, setStatus] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [offset, setOffset] = React.useState(0);
  const q = useQuery({
    queryKey: ['campaigns', status, search, offset],
    queryFn: () => api.listCampaigns({ status, search, limit: LIMIT, offset }),
    refetchInterval: 8000, placeholderData: (p) => p,
  });
  return (
    <>
      <PageHeader title="Campaigns" description="Each recipient is an independent job in the PostgreSQL queue, sent one at a time."
        actions={<Button asChild><Link to="/campaigns/new"><PlusCircle className="h-4 w-4" /> New campaign</Link></Button>} />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border/60 p-4">
          <div className="relative w-full max-w-xs"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input className="pl-9" placeholder="Search campaigns" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} aria-label="Search campaigns" /></div>
          <div className="flex flex-wrap gap-1">
            {STATUSES.map((s) => (
              <button key={s || 'all'} onClick={() => { setStatus(s); setOffset(0); }} className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors ${status === s ? 'bg-primary/25 text-foreground ring-1 ring-primary/40' : 'text-muted-foreground hover:bg-white/5'}`}>{s || 'All'}</button>
            ))}
          </div>
        </div>
        {q.isLoading ? <div className="space-y-3 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div> : q.data?.rows.length === 0 ? (
          <EmptyState icon={<PlusCircle className="h-5 w-5" />} title={status || search ? 'No campaigns match your filters' : 'Create your first campaign'}>Import recipients, write one message, and MailBlaster sends it individually and personalised at a safe pace.</EmptyState>
        ) : (
          <Table>
            <THead><TR><TH>Campaign</TH><TH>Status</TH><TH className="min-w-[160px]">Progress</TH><TH className="text-right">Recipients</TH><TH className="text-right">Sent</TH><TH className="text-right">Opened</TH><TH className="text-right">Replies</TH><TH className="text-right">Bounces</TH><TH className="text-right">Failed</TH><TH>Created</TH><TH className="text-right">Actions</TH></TR></THead>
            <TBody>{q.data?.rows.map((c) => {
              const done = c.sent + c.failed + c.skipped + c.bounced + c.unsubscribed;
              return (
                <TR key={c.id}>
                  <TD><Link to={`/campaigns/${c.id}`} className="font-medium hover:underline">{c.name}</Link><p className="max-w-[260px] truncate text-xs text-muted-foreground">{c.subject}</p></TD>
                  <TD><StatusBadge status={c.status} />{c.status === 'scheduled' && <p className="mt-1 text-[11px] text-muted-foreground">{fmtDate(c.start_at)}</p>}</TD>
                  <TD><Progress value={c.total ? (Math.min(done, c.total) / c.total) * 100 : 0} /><p className="mt-1 text-[11px] text-muted-foreground">{c.sent} sent · {c.queued + c.pending} pending</p></TD>
                  <TD className="text-right tabular-nums">{fmtNum(c.total)}</TD><TD className="text-right tabular-nums">{fmtNum(c.sent)}</TD><TD className="text-right tabular-nums">{fmtNum(c.opened)}</TD>
                  <TD className="text-right tabular-nums">{fmtNum(c.replied)}</TD><TD className="text-right tabular-nums">{fmtNum(c.bounced)}</TD><TD className="text-right tabular-nums">{fmtNum(c.failed)}</TD>
                  <TD className="whitespace-nowrap text-xs text-muted-foreground">{fmtDate(c.created_at, { time: false })}</TD>
                  <TD><CampaignActions c={c} /></TD>
                </TR>);
            })}</TBody>
          </Table>
        )}
        {q.data && q.data.total > 0 && <Pagination total={q.data.total} limit={LIMIT} offset={offset} onChange={setOffset} />}
      </Card>
    </>
  );
}
