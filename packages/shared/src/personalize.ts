import { escapeHtml } from './html';

export interface MergeSource {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  website?: string | null;
  position?: string | null;
  fields?: Record<string, unknown> | null;
}

export const STANDARD_VARIABLES = [
  'FirstName', 'LastName', 'FullName', 'Email', 'Company', 'Website', 'Position', 'CustomField1', 'CustomField2',
] as const;

const keyOf = (s: string) => s.toLowerCase().replace(/[\s_\-]/g, '');

/** Build the merge dictionary for one recipient. Keys are normalised (case/space/underscore-insensitive). */
export function buildMergeData(r: MergeSource): Record<string, string> {
  const d: Record<string, string> = {};
  const set = (k: string, v: unknown) => {
    if (v === null || v === undefined) return;
    const s = String(v).trim();
    if (s) d[keyOf(k)] = s;
  };
  for (const [k, v] of Object.entries(r.fields ?? {})) set(k, v);
  set('FirstName', r.first_name);
  set('LastName', r.last_name);
  set('Email', r.email);
  set('Company', r.company);
  set('Website', r.website);
  set('Position', r.position);
  const full = [r.first_name, r.last_name].map((x) => (x ?? '').trim()).filter(Boolean).join(' ');
  if (full) d[keyOf('FullName')] = full;
  return d;
}

const VAR_RE = /\{\{\s*([^{}|]+?)\s*(?:\|([^{}]*))?\}\}/g;

export interface RenderResult {
  text: string;
  /** variables that had neither a value nor a fallback (rendered as empty) */
  missing: string[];
}

/** {{FirstName}}, {{FirstName|there}}. Values are HTML-escaped when `html` is true (prevents injection from CSV data). */
export function renderTemplate(tpl: string, data: Record<string, string>, opts: { html?: boolean } = {}): RenderResult {
  const missing: string[] = [];
  const text = (tpl ?? '').replace(VAR_RE, (_m, name: string, fallback?: string) => {
    const v = data[keyOf(name)];
    if (v !== undefined) return opts.html ? escapeHtml(v) : v;
    if (fallback !== undefined) return opts.html ? escapeHtml(fallback.trim()) : fallback.trim();
    if (!missing.includes(name.trim())) missing.push(name.trim());
    return '';
  });
  return { text, missing };
}

export function extractVariables(tpl: string): string[] {
  const out = new Set<string>();
  for (const m of (tpl ?? '').matchAll(VAR_RE)) out.add(m[1].trim());
  return [...out];
}

/** Variables used in the template that are not provided by ANY recipient and have no fallback. */
export function findUnresolvedVariables(tpl: string, recipients: MergeSource[]): string[] {
  const used = [...(tpl ?? '').matchAll(VAR_RE)].filter((m) => m[2] === undefined).map((m) => m[1].trim());
  const unresolved = new Set<string>();
  for (const v of used) {
    if (!recipients.some((r) => buildMergeData(r)[keyOf(v)] !== undefined)) unresolved.add(v);
  }
  return [...unresolved];
}
