import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Download, Pencil, RotateCcw, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { useLiveCampaign } from '@/lib/live';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Dialog, DialogContent, EmptyState, Input, PageHeader, Pagination, Select, Skeleton, Switch, Table, TBody, TD, TH, THead, TR } from '@/components/ui';
import { StatusBadge } from '@/components/StatusBadge';
import { CampaignActions } from './Campaigns';
import { errMsg, useToast } from '@/components/toast';
import { downloadBlob, fmtDate, fmtNum, humanSeconds, pct, timeAgo } from '@/lib/utils';
import type { RecipientFilter } from '@mailblaster/shared';

const FILTERS: [RecipientFilter, string][] = [['all', 'All'], ['pending', 'Pending'], ['queued', 'Queued'], ['sent', 'Sent'], ['opened', 'Opened'], ['not_opened', 'Not opened'], ['clicked', 'Clicked'], ['replied', 'Replied'], ['no_reply', 'No reply'], ['bounced', 'Bounced'], ['unsubscribed', 'Unsubscribed'], ['failed', 'Failed'], ['skipped', 'Skipped']];
const LIMIT = 50;

function StatCard({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return <Card className="p-4"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1.5 text-2xl font-semibold tabular-nums">{value}</p>{hint && <p className="text-xs text-muted-foreground">{hint}</p>}</Card>;
}

export function RecipientDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['recipient', id], queryFn: () => api.recipientDetail(id!), enabled: !!id });
  const r = q.data?.recipient;
  const resolve = async (jobId: string, outcome: 'sent' | 'retry') => { try { await api.resolveJob(jobId, outcome); toast.success('Updated'); qc.invalidateQueries(); } catch (e) { toast.error(errMsg(e)); } };
  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={r?.email ?? 'Recipient'} description="Full history for this person" className="max-w-2xl">
        {q.isLoading || !r ? <Skeleton className="h-48" /> : (
          <div className="space-y-5 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div><p className="text-xs text-muted-foreground">Status</p><StatusBadge status={r.status} /></div>
              <div><p className="text-xs text-muted-foreground">Name</p>{[r.first_name, r.last_name].filter(Boolean).join(' ') || '—'}</div>
              <div><p className="text-xs text-muted-foreground">Sent</p>{fmtDate(r.sent_at)}</div>
              <div><p className="text-xs text-muted-foreground">Opens</p>{r.open_count ? `${r.open_count} (last ${fmtDate(r.last_opened_at)})` : r.sent_at ? '0 (or not trackable)' : 'Not available'}</div>
              <div><p className="text-xs text-muted-foreground">Clicks</p>{r.click_count || (r.sent_at ? 0 : 'Not available')}</div>
              <div><p className="text-xs text-muted-foreground">Reply</p>{r.replied_at ? fmtDate(r.replied_at) : r.sent_at ? 'None detected (needs read permission)' : 'Not available'}</div>
              {r.failure_reason && <div className="col-span-2"><p className="text-xs text-muted-foreground">Failure reason</p><span className="text-rose-300">{r.failure_reason}</span></div>}
              {r.skip_reason && <div className="col-span-2"><p className="text-xs text-muted-foreground">Skipped because</p>{r.skip_reason.replace(/_/g, ' ')}</div>}
              {r.stop_reason && <div className="col-span-2"><p className="text-xs text-muted-foreground">Follow-ups stopped</p>{r.stop_reason.replace(/_/g, ' ')}</div>}
            </div>
            {q.data.replies.map((x: any, i: number) => <Alert key={i} tone="success" title={`Reply from ${x.from ?? 'recipient'} · ${fmtDate(x.received_at)}`}>{x.snippet}</Alert>)}
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Emails &amp; follow-ups</p>
              {q.data.jobs.map((j: any) => (
                <div key={j.id} className="flex items-center justify-between gap-2 border-b border-border/40 py-1.5">
                  <span>{j.step_number === 0 ? 'Initial email' : `Follow-up ${j.step_number}`}</span>
                  <span className="flex items-center gap-2"><StatusBadge status={j.status} /><span className="text-xs text-muted-foreground">{j.status === 'queued' ? `due ${fmtDate(j.run_after)}` : ''}</span></span>
                  {j.status === 'ambiguous' && (
                    <span className="flex gap-1.5"><Button size="sm" variant="outline" onClick={() => resolve(j.id, 'sent')}>It was sent</Button><Button size="sm" variant="outline" onClick={() => resolve(j.id, 'retry')}>Not sent, retry</Button></span>)}
                </div>))}
              {q.data.jobs.some((j: any) => j.status === 'ambiguous') && <p className="mt-2 text-xs text-amber-300">Gmail never confirmed this send. Check your Gmail Sent folder, then choose. MailBlaster will not retry it automatically, to avoid sending a duplicate.</p>}
            </div>
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Timeline</p>
              <ul className="max-h-48 space-y-1 overflow-y-auto">{q.data.activity.map((a: any, i: number) => <li key={i} className="flex justify-between gap-3 text-xs"><span>{a.message}</span><span className="shrink-0 text-muted-foreground">{fmtDate(a.created_at)}</span></li>)}</ul>
            </div>
          </div>)}
      </DialogContent>
    </Dialog>
  );
}

export default function CampaignDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient(); const toast = useToast();
  const live = useLiveCampaign(id);
  const [filter, setFilter] = React.useState<RecipientFilter>('all');
  const [search, setSearch] = React.useState('');
  const [sort, setSort] = React.useState('created_at');
  const [dir, setDir] = React.useState<'asc' | 'desc'>('asc');
  const [offset, setOffset] = React.useState(0);
  const [open, setOpen] = React.useState<string | null>(null);

  const c = useQuery({ queryKey: ['campaign', id], queryFn: () => api.getCampaign(id), refetchInterval: (q) => (live ? 30_000 : ['queued', 'running', 'scheduled'].includes((q.state.data as any)?.status) ? 5000 : 20_000) });
  const r = useQuery({ queryKey: ['recipients', id, filter, search, sort, dir, offset], queryFn: () => api.campaignRecipients(id, { filter, search, sort, dir, limit: LIMIT, offset }), refetchInterval: live ? 30_000 : 10_000, placeholderData: (p) => p });
  const retry = useMutation({ mutationFn: () => api.retryFailed(id), onSuccess: (x) => { toast.success(`${x.requeued} job(s) re-queued`); qc.invalidateQueries(); }, onError: (e) => toast.error(errMsg(e)) });
  const followups = useMutation({ mutationFn: (v: boolean) => api.setFollowUps(id, v), onSuccess: () => { toast.success('Follow-up setting saved'); qc.invalidateQueries({ queryKey: ['campaign', id] }); }, onError: (e) => toast.error(errMsg(e)) });

  const data = c.data;
  if (c.isLoading) return <div className="space-y-4"><Skeleton className="h-10 w-1/3" /><Skeleton className="h-32" /><Skeleton className="h-64" /></div>;
  if (c.isError || !data) return <Alert tone="error">{c.isError ? (c.error as Error).message : 'Campaign not found'} <Link className="underline" to="/campaigns">Back to campaigns</Link></Alert>;
  const s = data.stats;
  const sortBy = (col: string) => { if (sort === col) setDir(dir === 'asc' ? 'desc' : 'asc'); else { setSort(col); setDir('asc'); } setOffset(0); };
  const Th = ({ col, children, className }: { col: string; children: React.ReactNode; className?: string }) => (
    <TH className={className}><button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => sortBy(col)}>{children}{sort === col && (dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}</button></TH>
  );
  const st = data.settings ?? {};

  return (
    <>
      <PageHeader title={data.name} description={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={data.status} /><span>Subject: {data.subject || '—'}</span>{live && <Badge tone="green">Live</Badge>}</span>}
        actions={<><CampaignActions c={{ id, status: data.status, name: data.name }} />{data.status === 'draft' && <Button asChild><Link to={`/campaigns/${id}/edit`}><Pencil className="h-4 w-4" /> Edit draft</Link></Button>}</>} />

      {data.jobs.ambiguous > 0 && <Alert tone="warn" className="mb-4" title={`${data.jobs.ambiguous} email(s) have an unknown outcome`}>Gmail did not confirm them, so they are held instead of being retried (a retry could send a duplicate). Open the recipient marked "Unknown outcome" below to resolve it.</Alert>}
      {data.jobs.failed > 0 && <Alert tone="error" className="mb-4" title={`${data.jobs.failed} job(s) failed`}><Button size="sm" variant="outline" className="mt-2" loading={retry.isPending} onClick={() => retry.mutate()}><RotateCcw className="h-3.5 w-3.5" /> Retry temporary failures</Button></Alert>}
      {data.account?.status === 'reauth_required' && <Alert tone="warn" className="mb-4" title="Sending is on hold">Google authorization for {data.account.email} expired. <Link className="underline" to="/settings/account">Reconnect Gmail</Link> and the queue continues automatically.</Alert>}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="Total recipients" value={fmtNum(s.total)} />
        <StatCard label="Sent" value={fmtNum(s.sent)} hint={pct(s.sent, s.total)} />
        <StatCard label="Pending" value={fmtNum(s.pending + s.queued)} hint={`${s.pending} draft · ${s.queued} queued`} />
        <StatCard label="Opened" value={fmtNum(s.opened)} hint={s.sent ? `${pct(s.opened, s.sent)} (approximate)` : 'Not available'} />
        <StatCard label="Clicked" value={fmtNum(s.clicked)} hint={s.sent ? pct(s.clicked, s.sent) : 'Not available'} />
        <StatCard label="Replied" value={fmtNum(s.replied)} hint={s.sent ? pct(s.replied, s.sent) : 'Not available'} />
        <StatCard label="Bounced" value={fmtNum(s.bounced)} />
        <StatCard label="Unsubscribed" value={fmtNum(s.unsubscribed)} />
        <StatCard label="Failed / skipped" value={`${fmtNum(s.failed)} / ${fmtNum(s.skipped)}`} />
        <StatCard label="Follow-ups sent" value={fmtNum(s.follow_ups_sent)} hint={data.jobs.followups_queued ? `${data.jobs.followups_queued} scheduled` : undefined} />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Card><CardHeader><CardTitle>Schedule &amp; pacing</CardTitle></CardHeader><CardContent className="space-y-1.5 text-sm">
          <p><span className="text-muted-foreground">Starts:</span> {fmtDate(data.start_at)}</p>
          {data.jobs.next_run_at && <p><span className="text-muted-foreground">Next email due:</span> {fmtDate(data.jobs.next_run_at)}</p>}
          <p><span className="text-muted-foreground">Gap:</span> {humanSeconds(st.min_interval_seconds ?? 0)} – {humanSeconds(st.max_interval_seconds ?? 0)}, max {st.daily_limit}/day</p>
          <p><span className="text-muted-foreground">Time zone:</span> {st.timezone}{st.business_hours?.enabled ? ` · ${st.business_hours.start}–${st.business_hours.end}` : ''}</p>
          <p><span className="text-muted-foreground">Sending as:</span> {data.account?.email ?? '—'}{data.delivery_mode === 'draft' ? ' (creates drafts)' : ''}</p>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Follow-ups</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
          <label className="flex items-center justify-between gap-3"><span>Automatic follow-ups</span><Switch checked={data.follow_ups_enabled} onCheckedChange={(v) => followups.mutate(v)} aria-label="Toggle follow-ups" /></label>
          {data.follow_ups.steps.length === 0 ? <p className="text-muted-foreground">No follow-up stages configured.</p> : data.follow_ups.steps.map((f: any) => (
            <p key={f.step_number} className="text-muted-foreground">Stage {f.step_number}: {f.enabled ? '' : '(off) '}{f.condition.replace('no_', 'if no ').replace('always', 'always')} after {f.delay_days} day(s)</p>))}
          <p className="text-xs text-muted-foreground">Stops automatically on reply, unsubscribe, bounce or cancel.</p>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Message</CardTitle></CardHeader><CardContent>
          <iframe title="Message preview" sandbox="" className="h-36 w-full rounded-md bg-white" srcDoc={`<body style="font:14px system-ui;margin:12px;color:#111">${data.body_html}</body>`} />
        </CardContent></Card>
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border/60 p-4">
          <div className="relative w-full max-w-xs"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input className="pl-9" placeholder="Search email, name, company" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} aria-label="Search recipients" /></div>
          <Select className="w-44" value={filter} onChange={(e) => { setFilter(e.target.value as RecipientFilter); setOffset(0); }} aria-label="Filter recipients">{FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
          <Button variant="outline" className="ml-auto" onClick={async () => { try { downloadBlob(await api.downloadCsv(`/api/campaigns/${id}/export.csv?filter=${filter}`), `${data.name.replace(/[^\w-]+/g, '_')}-${filter}.csv`); } catch (e) { toast.error(errMsg(e)); } }}><Download className="h-4 w-4" /> Export CSV</Button>
        </div>
        <div className="flex flex-wrap gap-1 border-b border-border/60 px-4 py-2">{FILTERS.map(([v, l]) => <button key={v} onClick={() => { setFilter(v); setOffset(0); }} className={`rounded-full px-2.5 py-0.5 text-xs ${filter === v ? 'bg-primary/25 ring-1 ring-primary/40' : 'text-muted-foreground hover:bg-white/5'}`}>{l}</button>)}</div>
        {r.isLoading ? <div className="p-4"><Skeleton className="h-40" /></div> : r.data?.rows.length === 0 ? <EmptyState title="No recipients match this filter" /> : (
          <Table>
            <THead><TR><Th col="email">Email</Th><TH>Name</TH><Th col="status">Status</Th><Th col="sent_at">Sent</Th><Th col="open_count" className="text-right">Opens</Th><Th col="last_opened_at">Last opened</Th><Th col="click_count" className="text-right">Clicks</Th><Th col="replied_at">Reply</Th><Th col="follow_ups_sent" className="text-right">Follow-ups</Th><TH>Failure / note</TH></TR></THead>
            <TBody>{r.data?.rows.map((x: any) => (
              <TR key={x.id} className="cursor-pointer" onClick={() => setOpen(x.id)}>
                <TD className="font-medium">{x.email}</TD>
                <TD>{[x.first_name, x.last_name].filter(Boolean).join(' ') || '—'}</TD>
                <TD>{x.ambiguous_job_id ? <Badge tone="amber">Unknown outcome</Badge> : <StatusBadge status={x.status} />}</TD>
                <TD className="whitespace-nowrap text-xs">{x.sent_at ? fmtDate(x.sent_at) : <span className="text-muted-foreground">{x.status === 'queued' ? 'Pending' : '—'}</span>}</TD>
                <TD className="text-right tabular-nums">{x.sent_at ? x.open_count : '—'}</TD>
                <TD className="whitespace-nowrap text-xs">{x.last_opened_at ? timeAgo(x.last_opened_at) : '—'}</TD>
                <TD className="text-right tabular-nums">{x.sent_at ? x.click_count : '—'}</TD>
                <TD className="whitespace-nowrap text-xs">{x.replied_at ? <Badge tone="violet">Replied {timeAgo(x.replied_at)}</Badge> : x.sent_at ? <span className="text-muted-foreground">No reply</span> : '—'}</TD>
                <TD className="text-right tabular-nums">{x.follow_ups_sent}{x.next_followup_at && <span className="block text-[11px] text-muted-foreground">next {timeAgo(x.next_followup_at)}</span>}</TD>
                <TD className="max-w-[220px] truncate text-xs text-muted-foreground">{x.failure_reason || (x.skip_reason ? `Skipped: ${x.skip_reason.replace(/_/g, ' ')}` : x.followups_stopped && x.stop_reason ? `Follow-ups stopped: ${x.stop_reason}` : '')}</TD>
              </TR>))}</TBody>
          </Table>)}
        {r.data && r.data.total > 0 && <Pagination total={r.data.total} limit={LIMIT} offset={offset} onChange={setOffset} />}
      </Card>
      <RecipientDialog id={open} onClose={() => setOpen(null)} />
    </>
  );
}
