import { isValidEmail, normalizeEmail } from './email';

export interface RecipientInput {
  email: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  website?: string;
  position?: string;
  fields?: Record<string, string>;
  contact_id?: string;
}

export type FieldKey = 'email' | 'first_name' | 'last_name' | 'full_name' | 'company' | 'website' | 'position' | 'custom' | 'ignore';
export const FIELD_LABELS: Record<FieldKey, string> = {
  email: 'Email', first_name: 'First name', last_name: 'Last name', full_name: 'Full name', company: 'Company',
  website: 'Website', position: 'Position', custom: 'Custom field', ignore: "Don't import",
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const SYN: Record<Exclude<FieldKey, 'custom' | 'ignore'>, string[]> = {
  email: ['email', 'emailaddress', 'mail', 'eaddress', 'emailid', 'workemail'],
  first_name: ['firstname', 'first', 'givenname', 'fname', 'forename'],
  last_name: ['lastname', 'last', 'surname', 'familyname', 'lname'],
  full_name: ['name', 'fullname', 'contactname'],
  company: ['company', 'companyname', 'organization', 'organisation', 'org', 'business', 'employer'],
  website: ['website', 'url', 'site', 'domain', 'web', 'websiteurl'],
  position: ['position', 'title', 'jobtitle', 'role', 'jobposition'],
};

export function guessMapping(headers: string[]): Record<string, FieldKey> {
  const used = new Set<FieldKey>();
  const out: Record<string, FieldKey> = {};
  for (const h of headers) {
    const n = norm(h);
    let hit: FieldKey = 'custom';
    for (const [k, syn] of Object.entries(SYN) as [FieldKey, string[]][]) {
      if (syn.includes(n) && !used.has(k)) { hit = k; break; }
    }
    if (!n) hit = 'ignore';
    if (hit !== 'custom') used.add(hit);
    out[h] = hit;
  }
  return out;
}

export function rowsToRecipients(rows: Record<string, unknown>[], mapping: Record<string, FieldKey>): RecipientInput[] {
  const out: RecipientInput[] = [];
  for (const row of rows) {
    const r: RecipientInput = { email: '' };
    const fields: Record<string, string> = {};
    let full = '';
    for (const [header, key] of Object.entries(mapping)) {
      const raw = row[header];
      const v = raw === null || raw === undefined ? '' : String(raw).trim();
      if (!v || key === 'ignore') continue;
      if (key === 'custom') fields[header.trim()] = v;
      else if (key === 'full_name') full = v;
      else (r as any)[key] = key === 'email' ? normalizeEmail(v) : v;
    }
    if (full && !r.first_name && !r.last_name) {
      const [first, ...rest] = full.split(/\s+/);
      r.first_name = first;
      if (rest.length) r.last_name = rest.join(' ');
    }
    if (Object.keys(fields).length) r.fields = fields;
    if (r.email || Object.keys(r).length > 1) out.push(r);
  }
  return out;
}

/** Accepts "a@x.com, b@y.com; Name <c@z.com>\n d@w.com". */
export function parsePastedList(text: string): RecipientInput[] {
  const out: RecipientInput[] = [];
  for (const chunk of (text ?? '').split(/[\n\r,;\t]+/)) {
    const t = chunk.trim();
    if (!t) continue;
    const named = t.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
    const email = normalizeEmail(named ? named[2] : t);
    const r: RecipientInput = { email };
    if (named && named[1].trim()) {
      const [first, ...rest] = named[1].trim().split(/\s+/);
      r.first_name = first;
      if (rest.length) r.last_name = rest.join(' ');
    }
    out.push(r);
  }
  return out;
}

export interface Analysis {
  valid: RecipientInput[];
  invalid: RecipientInput[];
  duplicates: RecipientInput[];
}

export function analyzeRecipients(list: RecipientInput[]): Analysis {
  const seen = new Set<string>();
  const a: Analysis = { valid: [], invalid: [], duplicates: [] };
  for (const r of list) {
    const email = normalizeEmail(r.email);
    if (!isValidEmail(email)) { a.invalid.push(r); continue; }
    if (seen.has(email)) { a.duplicates.push(r); continue; }
    seen.add(email);
    a.valid.push({ ...r, email });
  }
  return a;
}

/** All merge-tag names available for this list (standard + custom columns). */
export function availableVariables(list: RecipientInput[]): string[] {
  const std = ['FirstName', 'LastName', 'FullName', 'Email', 'Company', 'Website', 'Position', 'CustomField1', 'CustomField2'];
  const custom = new Set<string>();
  for (const r of list) for (const k of Object.keys(r.fields ?? {})) custom.add(k);
  for (const c of custom) if (!std.some((s) => s.toLowerCase() === c.toLowerCase())) std.push(c);
  return std;
}
