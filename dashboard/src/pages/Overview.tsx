import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, Eye, MailCheck, MailX, MousePointerClick, PlusCircle, Reply, Send, Ban, Hourglass, Users, FolderOpen, SkipForward } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, PageHeader, Skeleton } from '@/components/ui';
import { StatusBadge } from '@/components/StatusBadge';
import { CampaignBars, DailyChart, SERIES } from '@/components/charts';
import { fmtDate, fmtNum, timeAgo } from '@/lib/utils';

function Stat({ icon: Icon, label, value, sub, tone = 'text-primary' }: { icon: any; label: string; value: string; sub?: string; tone?: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between"><span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span><Icon className={`h-4 w-4 ${tone}`} /></div>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </Card>
  );
}

export default function Overview() {
  const { me } = useAuth();
  const q = useQuery({ queryKey: ['overview'], queryFn: () => api.overview(), refetchInterval: 20_000 });
  const d = q.data;
  const hasAccount = me?.accounts.some((a) => a.status === 'active');

  return (
    <>
      <PageHeader title="Overview" description="Everything below is computed live from your PostgreSQL database."
        actions={<Button asChild><Link to="/campaigns/new"><PlusCircle className="h-4 w-4" /> New campaign</Link></Button>} />
      {!hasAccount && (
        <Alert tone="warn" className="mb-6" title="Connect your Gmail account to start sending">
          MailBlaster sends through the official Gmail API using Google OAuth - no passwords. <Link className="font-medium underline" to="/settings/account">Connect Gmail</Link>
        </Alert>
      )}
      {q.isError && <Alert tone="error" className="mb-6">{(q.error as Error).message}</Alert>}
      {q.isLoading || !d ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            <Stat icon={FolderOpen} label="Campaigns" value={fmtNum(d.totals.campaigns)} />
            <Stat icon={Users} label="Recipients" value={fmtNum(d.totals.recipients)} />
            <Stat icon={Send} label="Sent" value={fmtNum(d.totals.sent)} tone="text-sky-400" />
            <Stat icon={Hourglass} label="Pending" value={fmtNum(d.totals.pending)} sub="queued, not yet sent" tone="text-amber-400" />
            <Stat icon={Eye} label="Opened" value={fmtNum(d.totals.opened)} sub={d.rates.open_rate != null ? `${d.rates.open_rate}% open rate*` : 'Not available yet'} tone="text-emerald-400" />
            <Stat icon={MousePointerClick} label="Clicked" value={fmtNum(d.totals.clicked)} sub={d.rates.click_rate != null ? `${d.rates.click_rate}%` : undefined} tone="text-cyan-300" />
            <Stat icon={Reply} label="Replied" value={fmtNum(d.totals.replied)} sub={d.rates.reply_rate != null ? `${d.rates.reply_rate}% reply rate` : undefined} tone="text-violet-400" />
            <Stat icon={MailX} label="Bounced" value={fmtNum(d.totals.bounced)} tone="text-orange-400" />
            <Stat icon={AlertTriangle} label="Failed" value={fmtNum(d.totals.failed)} tone="text-rose-400" />
            <Stat icon={SkipForward} label="Skipped" value={fmtNum(d.totals.skipped)} tone="text-muted-foreground" />
            <Stat icon={Ban} label="Unsubscribed" value={fmtNum(d.totals.unsubscribed)} tone="text-amber-400" />
            <Stat icon={MailCheck} label="Contacts" value={fmtNum(d.totals.contacts)} sub={`${fmtNum(d.totals.suppressed)} suppressed`} />
          </div>
          <p className="-mt-3 text-xs text-muted-foreground">*Open tracking uses an invisible pixel. Image blocking, privacy proxies and security scanners make opens approximate; replies need the optional Gmail read permission.</p>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card><CardHeader><CardTitle>Daily activity · last 30 days</CardTitle></CardHeader><CardContent>
              <DailyChart data={d.daily} series={[{ key: 'sent', name: 'Sent', color: SERIES.sent }, { key: 'opened', name: 'First opens', color: SERIES.opened }, { key: 'replied', name: 'Replies', color: SERIES.replied }]} />
            </CardContent></Card>
            <Card><CardHeader><CardTitle>Campaign performance</CardTitle></CardHeader><CardContent>
              {d.campaign_performance.length === 0 ? <EmptyState title="No campaigns launched yet" /> : <CampaignBars data={d.campaign_performance} />}
            </CardContent></Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-1"><CardHeader><CardTitle className="flex items-center gap-2"><CalendarClock className="h-4 w-4" /> Upcoming campaigns</CardTitle></CardHeader><CardContent>
              {d.upcoming.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">Nothing scheduled</p> : d.upcoming.map((c: any) => (
                <Link key={c.id} to={`/campaigns/${c.id}`} className="flex items-center justify-between rounded-md px-2 py-2 hover:bg-white/5">
                  <div><p className="text-sm font-medium">{c.name}</p><p className="text-xs text-muted-foreground">{fmtDate(c.start_at)} · {c.recipients} recipients</p></div><StatusBadge status={c.status} />
                </Link>))}
            </CardContent></Card>
            <Card><CardHeader><CardTitle>Recent replies</CardTitle></CardHeader><CardContent>
              {d.recent_replies.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">No replies detected yet. Enable reply detection in Account &amp; Integrations.</p> : d.recent_replies.map((r: any) => (
                <Link key={r.id} to={`/campaigns/${r.campaign_id}`} className="block rounded-md px-2 py-2 hover:bg-white/5">
                  <p className="text-sm font-medium">{r.from_email}</p><p className="line-clamp-2 text-xs text-muted-foreground">{r.snippet}</p><p className="text-[11px] text-muted-foreground">{r.campaign_name} · {timeAgo(r.received_at)}</p>
                </Link>))}
            </CardContent></Card>
            <Card><CardHeader><CardTitle className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-rose-400" /> Failed jobs</CardTitle></CardHeader><CardContent>
              {d.failed_jobs.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">No failed jobs</p> : d.failed_jobs.map((j: any) => (
                <Link key={j.id} to={`/campaigns/${j.campaign_id}`} className="block rounded-md px-2 py-2 hover:bg-white/5">
                  <div className="flex items-center justify-between gap-2"><p className="truncate text-sm font-medium">{j.email}</p><StatusBadge status={j.status} /></div>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{j.last_error}</p>
                </Link>))}
            </CardContent></Card>
          </div>

          <Card><CardHeader><CardTitle>Recent activity</CardTitle></CardHeader><CardContent>
            {d.recent_activity.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">Activity will appear here as soon as you create a campaign.</p> : (
              <ul className="divide-y divide-border/50">{d.recent_activity.map((a: any) => (
                <li key={a.id} className="flex items-start justify-between gap-4 py-2.5 text-sm"><span>{a.message}{a.campaign_name && <span className="text-muted-foreground"> · {a.campaign_name}</span>}</span><span className="shrink-0 text-xs text-muted-foreground">{timeAgo(a.created_at)}</span></li>))}</ul>)}
          </CardContent></Card>
        </div>
      )}
    </>
  );
}
