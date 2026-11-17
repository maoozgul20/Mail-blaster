import * as React from 'react';
import { DELAY_PRESETS, SCHEDULE_PRESETS, WEEKDAYS, estimateDuration, localInputToUtc, resolveSchedulePreset, utcToLocalInput, type CampaignSettings, type SchedulePresetId } from '@mailblaster/shared';
import { Alert, Button, Field, Input, Select, Switch } from '../ui';
import { browserTz, cn, fmtDate, timezones } from '@/lib/utils';

export interface ScheduleState { preset: SchedulePresetId; custom: string }

const Chip = ({ active, children, onClick }: { active?: boolean; children: React.ReactNode; onClick: () => void }) => (
  <button type="button" onClick={onClick} className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors', active ? 'border-primary bg-primary/20 text-foreground' : 'border-border text-muted-foreground hover:bg-white/5')}>{children}</button>
);

export function resolveStart(s: ScheduleState, tz: string): Date {
  if (s.preset === 'custom') return localInputToUtc(s.custom, tz) ?? new Date();
  return resolveSchedulePreset(s.preset, new Date(), tz);
}

interface Props {
  settings: CampaignSettings; onSettings: (p: Partial<CampaignSettings>) => void;
  schedule: ScheduleState; onSchedule: (s: ScheduleState) => void;
  endAt: string; onEndAt: (v: string) => void;
  recipients: number; delivery: 'send' | 'draft'; onDelivery: (d: 'send' | 'draft') => void; hasCompose: boolean;
}

export function SchedulePanel({ settings, onSettings, schedule, onSchedule, endAt, onEndAt, recipients, delivery, onDelivery, hasCompose }: Props) {
  const tz = settings.timezone;
  const [unit, setUnit] = React.useState<'seconds' | 'minutes'>(settings.min_interval_seconds >= 120 && settings.min_interval_seconds % 60 === 0 ? 'minutes' : 'seconds');
  const mul = unit === 'minutes' ? 60 : 1;
  const preset = DELAY_PRESETS.find((p) => p.min === settings.min_interval_seconds && p.max === settings.max_interval_seconds);
  const start = resolveStart(schedule, tz);
  const est = estimateDuration(recipients, settings.daily_limit, settings.min_interval_seconds, settings.max_interval_seconds);
  const fast = settings.max_interval_seconds < 60;

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h4 className="text-sm font-semibold">Delivery</h4>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="radio" name="delivery" checked={delivery === 'send'} onChange={() => onDelivery('send')} className="accent-indigo-500" /> Send emails</label>
          <label className={cn('flex items-center gap-2', !hasCompose && 'opacity-60')}><input type="radio" name="delivery" disabled={!hasCompose} checked={delivery === 'draft'} onChange={() => onDelivery('draft')} className="accent-indigo-500" /> Create drafts (review, then send yourself)</label>
        </div>
        {!hasCompose && <p className="text-xs text-muted-foreground">Draft mode needs the optional "create drafts" Google permission (Account &amp; Integrations).</p>}
      </section>

      <section className="space-y-3">
        <h4 className="text-sm font-semibold">Schedule</h4>
        <div className="flex flex-wrap gap-2">
          {SCHEDULE_PRESETS.map((p) => <Chip key={p.id} active={schedule.preset === p.id} onClick={() => onSchedule({ ...schedule, preset: p.id })}>{p.label}</Chip>)}
          <Chip active={schedule.preset === 'custom'} onClick={() => onSchedule({ preset: 'custom', custom: schedule.custom || utcToLocalInput(new Date(Date.now() + 3600_000), tz) })}>Custom date &amp; time</Chip>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {schedule.preset === 'custom' && <Field label={`Start (${tz})`}><Input type="datetime-local" value={schedule.custom} onChange={(e) => onSchedule({ preset: 'custom', custom: e.target.value })} /></Field>}
          <Field label="Time zone"><Select value={settings.timezone} onChange={(e) => onSettings({ timezone: e.target.value })}>{[...new Set([browserTz(), 'UTC', ...timezones()])].map((z) => <option key={z}>{z}</option>)}</Select></Field>
          <Field label="Campaign end (optional)" hint="Emails not sent by then are skipped"><Input type="datetime-local" value={endAt} onChange={(e) => onEndAt(e.target.value)} /></Field>
        </div>
        <p className="text-xs text-muted-foreground">First email: <b className="text-foreground">{schedule.preset === 'now' ? 'immediately' : fmtDate(start, { tz })}</b> ({tz}). The scheduler runs in the cloud, so your computer can be off.</p>
      </section>

      <section className="space-y-3">
        <h4 className="text-sm font-semibold">Speed</h4>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Send max (emails / day)"><Input className="w-28" type="number" min={1} max={2000} value={settings.daily_limit} onChange={(e) => onSettings({ daily_limit: Math.max(1, Math.min(2000, +e.target.value || 1)) })} /></Field>
          <Field label="Pause between emails"><div className="flex items-center gap-2">
            <Input className="w-20" type="number" min={0} value={Math.round(settings.min_interval_seconds / mul)} onChange={(e) => onSettings({ min_interval_seconds: Math.max(0, +e.target.value || 0) * mul })} aria-label="Minimum pause" />
            <span className="text-sm text-muted-foreground">to</span>
            <Input className="w-20" type="number" min={0} value={Math.round(settings.max_interval_seconds / mul)} onChange={(e) => onSettings({ max_interval_seconds: Math.max(0, +e.target.value || 0) * mul })} aria-label="Maximum pause" />
            <Select className="w-28" value={unit} onChange={(e) => setUnit(e.target.value as any)} aria-label="Unit"><option value="seconds">seconds</option><option value="minutes">minutes</option></Select>
          </div></Field>
        </div>
        <div className="flex flex-wrap gap-2">
          {DELAY_PRESETS.map((p) => <Chip key={p.id} active={preset?.id === p.id} onClick={() => { onSettings({ min_interval_seconds: p.min, max_interval_seconds: p.max }); setUnit(p.min >= 120 ? 'minutes' : 'seconds'); }}>{p.label}</Chip>)}
          <Chip active={!preset} onClick={() => undefined}>Custom range</Chip>
        </div>
        <p className="text-xs text-muted-foreground">Each email waits a random time inside this range. {recipients > 0 && <>About <b className="text-foreground">{est.perDay}/day</b> → {recipients} recipients take roughly <b className="text-foreground">{est.days === 1 ? `${est.hours} h` : `${est.days} days`}</b>.</>} Fast presets can never exceed the daily limit or Gmail's own account limits.</p>
        {fast && <Alert tone="warn">Very short gaps can look like automated bulk mail to Gmail and recipients' providers. Consider 1-5 minutes or longer for cold outreach. (Short gaps are paced inside one cloud run, so they are limited by the free-tier CPU budget; see docs/FREE_TIER.md.)</Alert>}
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-3"><Switch checked={settings.business_hours.enabled} onCheckedChange={(v) => onSettings({ business_hours: { ...settings.business_hours, enabled: v } })} aria-label="Business hours only" /><span className="text-sm font-semibold">Only send during business hours</span></div>
        {settings.business_hours.enabled && (
          <div className="flex flex-wrap items-center gap-2 text-sm"><Input type="time" className="w-32" value={settings.business_hours.start} onChange={(e) => onSettings({ business_hours: { ...settings.business_hours, start: e.target.value } })} aria-label="Start time" /> to <Input type="time" className="w-32" value={settings.business_hours.end} onChange={(e) => onSettings({ business_hours: { ...settings.business_hours, end: e.target.value } })} aria-label="End time" /> <span className="text-xs text-muted-foreground">in {tz}</span></div>
        )}
        <div className="flex flex-wrap gap-2" role="group" aria-label="Working weekdays">
          {WEEKDAYS.map((d) => <Chip key={d.n} active={settings.weekdays.includes(d.n)} onClick={() => { const w = settings.weekdays.includes(d.n) ? settings.weekdays.filter((x) => x !== d.n) : [...settings.weekdays, d.n].sort(); if (w.length) onSettings({ weekdays: w }); }}>{d.label}</Chip>)}
        </div>
      </section>

      <section className="space-y-3">
        <h4 className="text-sm font-semibold">Tracking &amp; compliance</h4>
        <label className="flex items-center gap-3 text-sm"><Switch checked={settings.track_opens} onCheckedChange={(v) => onSettings({ track_opens: v })} /> Track opens (invisible pixel; approximate)</label>
        <label className="flex items-center gap-3 text-sm"><Switch checked={settings.track_clicks} onCheckedChange={(v) => onSettings({ track_clicks: v })} /> Track link clicks</label>
        <label className="flex items-center gap-3 text-sm"><Switch checked={settings.unsubscribe_link} onCheckedChange={(v) => onSettings({ unsubscribe_link: v })} /> Include an unsubscribe link (recommended; required by anti-spam laws for marketing email)</label>
      </section>
    </div>
  );
}
