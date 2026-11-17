export interface DelayPreset { id: string; label: string; min: number; max: number }
/** Seconds. The server always additionally enforces the Gmail daily cap, so fast presets can never exceed provider limits. */
export const DELAY_PRESETS: DelayPreset[] = [
  { id: '5-10s', label: '5–10 sec', min: 5, max: 10 },
  { id: '10-60s', label: '10–60 sec', min: 10, max: 60 },
  { id: '1-5m', label: '1–5 min', min: 60, max: 300 },
  { id: '5-10m', label: '5–10 min', min: 300, max: 600 },
  { id: '10-20m', label: '10–20 min', min: 600, max: 1200 },
];

export type SchedulePresetId = 'now' | '5min' | '1hour' | '3hours' | 'tomorrow8' | 'tomorrow13' | 'tomorrow19' | 'custom';
export const SCHEDULE_PRESETS: { id: SchedulePresetId; label: string }[] = [
  { id: 'now', label: 'Now' },
  { id: '5min', label: 'In 5 min' },
  { id: '1hour', label: 'In 1 hour' },
  { id: '3hours', label: 'In 3 hours' },
  { id: 'tomorrow8', label: 'Tomorrow 8am' },
  { id: 'tomorrow13', label: 'Tomorrow 1pm' },
  { id: 'tomorrow19', label: 'Tomorrow 7pm' },
];

export function tzOffsetMinutes(date: Date, tz: string): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** Wall-clock time in `tz` -> UTC instant (handles DST). */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let utc = wall;
  for (let i = 0; i < 3; i++) utc = wall - tzOffsetMinutes(new Date(utc), tz) * 60000;
  return new Date(utc);
}

export function localParts(date: Date, tz: string) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(date);
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return { y: g('year'), mo: g('month'), d: g('day'), h: g('hour'), mi: g('minute') };
}

export function resolveSchedulePreset(id: SchedulePresetId, now: Date, tz: string): Date {
  switch (id) {
    case 'now': return now;
    case '5min': return new Date(now.getTime() + 5 * 60_000);
    case '1hour': return new Date(now.getTime() + 3600_000);
    case '3hours': return new Date(now.getTime() + 3 * 3600_000);
    default: {
      const hour = id === 'tomorrow8' ? 8 : id === 'tomorrow13' ? 13 : 19;
      const l = localParts(now, tz);
      const next = new Date(Date.UTC(l.y, l.mo - 1, l.d + 1));
      return zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), hour, 0, tz);
    }
  }
}

/** <input type="datetime-local"> value ("2030-01-07T09:30") interpreted in `tz` -> UTC instant. */
export function localInputToUtc(v: string, tz: string): Date | null {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], tz) : null;
}

export function utcToLocalInput(d: Date, tz: string): string {
  const l = localParts(d, tz);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${l.y}-${p(l.mo)}-${p(l.d)}T${p(l.h)}:${p(l.mi)}`;
}

export function estimateDuration(recipients: number, dailyLimit: number, minSec: number, maxSec: number) {
  const avg = (minSec + maxSec) / 2;
  const perDayByTime = avg > 0 ? Math.floor(86400 / avg) : Infinity;
  const perDay = Math.max(1, Math.min(dailyLimit, perDayByTime));
  const days = Math.ceil(recipients / perDay);
  const lastDayCount = recipients - (days - 1) * perDay;
  const hours = ((days - 1) * 24) + (lastDayCount * avg) / 3600;
  return { perDay, days, hours: Math.round(hours * 10) / 10 };
}

export const WEEKDAYS = [
  { n: 1, label: 'Mon' }, { n: 2, label: 'Tue' }, { n: 3, label: 'Wed' }, { n: 4, label: 'Thu' },
  { n: 5, label: 'Fri' }, { n: 6, label: 'Sat' }, { n: 7, label: 'Sun' },
];
