import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, Eye, MailCheck, MailX, MousePointerClick, PlusCircle, Reply, Send, Ban, Hourglass, Users, FolderOpen, SkipForward } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, PageHeader, Skeleton } from '@/components/ui';
import { StatusBadge } from '@/components/StatusBadge';
import { CampaignBars, DailyChart, SERIES } from '@/components/charts';
import { fmtDate, fmtNum, timeAgo } from '@/lib/utils';
import { CountUp } from '@/components/motion';

const CHIP: Record<string, string> = {
  'text-primary': 'bg-indigo-500/15 text-indigo-300', 'text-sky-400': 'bg-sky-500/15 text-sky-300', 'text-amber-400': 'bg-amber-500/15 text-amber-300',
  'text-emerald-400': 'bg-emerald-500/15 text-emerald-300', 'text-cyan-300': 'bg-cyan-500/15 text-cyan-300', 'text-violet-400': 'bg-violet-500/15 text-violet-300',
  'text-orange-400': 'bg-orange-500/15 text-orange-300', 'text-rose-400': 'bg-rose-500/15 text-rose-300', 'text-muted-foreground': 'bg-white/10 text-slate-300',
};
function Stat({ icon: Icon, label, value, sub, tone = 'text-primary', raw }: { icon: any; label: string; value: number | string; sub?: string; tone?: string; raw?: boolean }) {
  return (
    <Card className="lift p-4">
      <div className="flex items-center justify-between"><span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span><span className={`grid h-8 w-8 place-items-center rounded-lg ${CHIP[tone] ?? CHIP['text-primary']}`}><Icon className="h-4 w-4" /></span></div>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{typeof value === 'number' && !raw ? <CountUp value={value} /> : value}</p>
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
          <div className="stagger grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            <Stat icon={FolderOpen} label="Campaigns" value={d.totals.campaigns ?? 0} />
            <Stat icon={Users} label="Recipients" value={d.totals.recipients ?? 0} />
            <Stat icon={Send} label="Sent" value={d.totals.sent ?? 0} tone="text-sky-400" />
            <Stat icon={Hourglass} label="Pending" value={d.totals.pending ?? 0} sub="queued, not yet sent" tone="text-amber-400" />
            <Stat icon={Eye} label="Opened" value={d.totals.opened ?? 0} sub={d.rates.open_rate != null ? `${d.rates.open_rate}% open rate*` : 'Not available yet'} tone="text-emerald-400" />
            <Stat icon={MousePointerClick} label="Clicked" value={d.totals.clicked ?? 0} sub={d.rates.click_rate != null ? `${d.rates.click_rate}%` : undefined} tone="text-cyan-300" />
            <Stat icon={Reply} label="Replied" value={d.totals.replied ?? 0} sub={d.rates.reply_rate != null ? `${d.rates.reply_rate}% reply rate` : undefined} tone="text-violet-400" />
            <Stat icon={MailX} label="Bounced" value={d.totals.bounced ?? 0} tone="text-orange-400" />
            <Stat icon={AlertTriangle} label="Failed" value={d.totals.failed ?? 0} tone="text-rose-400" />
            <Stat icon={SkipForward} label="Skipped" value={d.totals.skipped ?? 0} tone="text-muted-foreground" />
            <Stat icon={Ban} label="Unsubscribed" value={d.totals.unsubscribed ?? 0} tone="text-amber-400" />
            <Stat icon={MailCheck} label="Contacts" value={d.totals.contacts ?? 0} sub={`${fmtNum(d.totals.suppressed)} suppressed`} />
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
