import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...i: ClassValue[]) => twMerge(clsx(i));

export const fmtNum = (n: number | null | undefined) => (n ?? 0).toLocaleString();
export const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 1000) / 10}%` : '—');

export function fmtDate(d: string | Date | null | undefined, opts: { time?: boolean; tz?: string } = {}) {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', ...(opts.time === false ? {} : { hour: '2-digit', minute: '2-digit' }), timeZone: opts.tz,
  }).format(date);
}

export function timeAgo(d: string | null | undefined) {
  if (!d) return '—';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 0) { const f = -s; return f < 3600 ? `in ${Math.ceil(f / 60)}m` : f < 86400 ? `in ${Math.round(f / 3600)}h` : `in ${Math.round(f / 86400)}d`; }
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const timezones = (): string[] => {
  try { return (Intl as any).supportedValuesOf('timeZone') as string[]; } catch { return ['UTC', 'America/New_York', 'Europe/London', 'Asia/Karachi']; }
};
export const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export const humanSeconds = (s: number) => (s < 60 ? `${s} sec` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round((s / 3600) * 10) / 10} h`);

import { utcToLocalInput } from '@mailblaster/shared';
export const utcToLocalInputSafe = (iso: string, tz: string) => { try { return utcToLocalInput(new Date(iso), tz); } catch { return ''; } };
