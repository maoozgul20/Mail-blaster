import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export const SERIES = { sent: 'var(--series-1)', opened: 'var(--series-2)', replied: 'var(--series-3)', bounced: 'var(--series-4)', clicked: '#7dd3fc' } as const;
const axis = { stroke: 'hsl(224 14% 66%)', fontSize: 11, tickLine: false, axisLine: false } as const;

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass rounded-lg bg-card/95 px-3 py-2 text-xs shadow-xl">
      <p className="mb-1 font-medium">{label}</p>
      {payload.map((p: any) => (
        <p key={p.dataKey} className="flex items-center justify-between gap-6"><span className="flex items-center gap-1.5 text-muted-foreground"><i className="inline-block h-2 w-2 rounded-full" style={{ background: p.color }} />{p.name}</span><b>{p.value}</b></p>
      ))}
    </div>
  );
}

export function DailyChart({ data, series }: { data: any[]; series: { key: string; name: string; color: string }[] }) {
  const rows = data.map((d) => ({ ...d, label: new Date(d.date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }));
  return (
    <div role="img" aria-label={`Daily chart of ${series.map((s) => s.name).join(', ')}`} className="h-64 w-full">
      <ResponsiveContainer>
        <AreaChart data={rows} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <defs>{series.map((s) => (<linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={s.color} stopOpacity={0.35} /><stop offset="100%" stopColor={s.color} stopOpacity={0} /></linearGradient>))}</defs>
          <CartesianGrid stroke="hsl(228 24% 20%)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" {...axis} interval="preserveStartEnd" minTickGap={24} />
          <YAxis {...axis} allowDecimals={false} />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'hsl(224 14% 66%)', strokeDasharray: '3 3' }} />
          <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
          {series.map((s) => (<Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} fill={`url(#g-${s.key})`} dot={false} activeDot={{ r: 4, stroke: 'hsl(228 30% 11%)', strokeWidth: 2 }} />))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function CampaignBars({ data }: { data: { name: string; sent: number; opened: number; replied: number; bounced: number }[] }) {
  const rows = data.map((d) => ({ ...d, name: d.name.length > 16 ? d.name.slice(0, 15) + '…' : d.name }));
  return (
    <div role="img" aria-label="Campaign performance bar chart" className="h-64 w-full">
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ top: 8, right: 8, left: -18, bottom: 0 }} barGap={2}>
          <CartesianGrid stroke="hsl(228 24% 20%)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="name" {...axis} interval={0} angle={-20} textAnchor="end" height={50} />
          <YAxis {...axis} allowDecimals={false} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: 'hsl(228 28% 17% / .6)' }} />
          <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="sent" name="Sent" fill={SERIES.sent} radius={[4, 4, 0, 0]} maxBarSize={22} />
          <Bar dataKey="opened" name="Opened" fill={SERIES.opened} radius={[4, 4, 0, 0]} maxBarSize={22} />
          <Bar dataKey="replied" name="Replied" fill={SERIES.replied} radius={[4, 4, 0, 0]} maxBarSize={22} />
          <Bar dataKey="bounced" name="Bounced" fill={SERIES.bounced} radius={[4, 4, 0, 0]} maxBarSize={22} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
