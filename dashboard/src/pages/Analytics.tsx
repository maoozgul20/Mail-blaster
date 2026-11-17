import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, EmptyState, PageHeader, Select, Skeleton, Table, TBody, TD, TH, THead, TR } from '@/components/ui';
import { DailyChart, SERIES } from '@/components/charts';
import { fmtNum, pct } from '@/lib/utils';

export default function Analytics() {
  const [days, setDays] = React.useState(30);
  const q = useQuery({ queryKey: ['analytics', days], queryFn: () => api.analytics(days) });
  const d = q.data;
  const sum = (k: string) => (d?.daily ?? []).reduce((a: number, r: any) => a + (r[k] ?? 0), 0);
  return (
    <>
      <PageHeader title="Analytics" description="Opens are approximate (image blocking, privacy proxies and scanners). Replies need the optional read permission. Nothing here is estimated or invented: missing data shows as “—”."
        actions={<Select className="w-40" value={days} onChange={(e) => setDays(+e.target.value)} aria-label="Range"><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></Select>} />
      {q.isLoading || !d ? <Skeleton className="h-96" /> : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            {[['Sent', sum('sent'), null], ['Opens', sum('opened'), pct(sum('opened'), sum('sent'))], ['Clicks', sum('clicked'), pct(sum('clicked'), sum('sent'))], ['Replies', sum('replied'), pct(sum('replied'), sum('sent'))], ['Hard bounces', sum('bounced'), pct(sum('bounced'), sum('sent'))]].map(([l, v, p]) => (
              <Card key={l as string} className="p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">{l}</p><p className="mt-1 text-2xl font-semibold tabular-nums">{fmtNum(v as number)}</p>{p && <p className="text-xs text-muted-foreground">{p as string} of sent</p>}</Card>))}
          </div>
          <Card><CardHeader><CardTitle>Daily volume &amp; engagement</CardTitle></CardHeader><CardContent>
            <DailyChart data={d.daily} series={[{ key: 'sent', name: 'Sent', color: SERIES.sent }, { key: 'opened', name: 'Opens', color: SERIES.opened }, { key: 'replied', name: 'Replies', color: SERIES.replied }, { key: 'bounced', name: 'Bounces', color: SERIES.bounced }]} />
          </CardContent></Card>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card><CardHeader><CardTitle>By campaign</CardTitle></CardHeader>
              {d.by_campaign.length === 0 ? <EmptyState title="No data yet" /> : <Table><THead><TR><TH>Campaign</TH><TH className="text-right">Sent</TH><TH className="text-right">Open rate</TH><TH className="text-right">Reply rate</TH><TH className="text-right">Bounce rate</TH></TR></THead>
                <TBody>{d.by_campaign.map((c: any) => (<TR key={c.id}><TD><Link className="hover:underline" to={`/campaigns/${c.id}`}>{c.name}</Link></TD><TD className="text-right tabular-nums">{c.sent}</TD><TD className="text-right tabular-nums">{pct(c.opened, c.sent)}</TD><TD className="text-right tabular-nums">{pct(c.replied, c.sent)}</TD><TD className="text-right tabular-nums">{pct(c.bounced, c.sent)}</TD></TR>))}</TBody></Table>}</Card>
            <Card><CardHeader><CardTitle>Top clicked links</CardTitle></CardHeader>
              {d.top_links.length === 0 ? <EmptyState title="No clicks recorded in this range" /> : <Table><THead><TR><TH>URL</TH><TH className="text-right">Clicks</TH><TH className="text-right">People</TH></TR></THead>
                <TBody>{d.top_links.map((l: any) => (<TR key={l.url}><TD className="max-w-xs truncate" title={l.url}>{l.url}</TD><TD className="text-right tabular-nums">{l.clicks}</TD><TD className="text-right tabular-nums">{l.unique_clickers}</TD></TR>))}</TBody></Table>}</Card>
          </div>
        </div>)}
    </>
  );
}
