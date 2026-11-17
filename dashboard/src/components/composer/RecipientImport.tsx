import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import Papa from 'papaparse';
import readXlsxFile, { readSheetNames } from 'read-excel-file';
import { FileSpreadsheet, FileText, Sheet, Trash2, Upload, Users, X } from 'lucide-react';
import { FIELD_LABELS, analyzeRecipients, guessMapping, parsePastedList, rowsToRecipients, type FieldKey, type RecipientInput } from '@mailblaster/shared';
import { api } from '@/lib/api';
import { Alert, Badge, Button, Field, Input, Select, Tabs, TabsContent, TabsList, TabsTrigger, Table, TBody, TD, TH, THead, TR, Textarea } from '../ui';
import { errMsg, useToast } from '../toast';
import { downloadBlob } from '@/lib/utils';

interface Raw { headers: string[]; rows: Record<string, unknown>[]; source: string }

const SAMPLE = [
  { email: 'ali@example.com', first_name: 'Ali', company: 'Acme Digital', website: 'acme.example.com', fields: { Notes: 'Met at the SEO meetup' } },
  { email: 'sara@example.com', first_name: 'Sara', company: 'Beta Media', website: 'betamedia.example.com', fields: { Notes: 'Sells guest posts' } },
  { email: 'john@example.com', company: 'Gamma Ltd', website: 'gamma.example.com', fields: { Notes: 'No first name: {{FirstName|there}} says "there"' } },
] satisfies RecipientInput[];

function normaliseRows(table: unknown[][]): Raw['rows'] & { _h?: string[] } {
  const [head = [], ...rest] = table;
  const seen = new Map<string, number>();
  const headers = head.map((h, i) => {
    let name = String(h ?? '').trim() || `Column ${i + 1}`;
    const n = (seen.get(name) ?? 0) + 1; seen.set(name, n);
    if (n > 1) name = `${name} (${n})`;
    return name;
  });
  const rows = rest.filter((r) => r.some((c) => String(c ?? '').trim())).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
  return Object.assign(rows, { _h: headers });
}

export function RecipientImport({ value, onChange }: { value: RecipientInput[]; onChange: (r: RecipientInput[]) => void }) {
  const toast = useToast();
  const [tab, setTab] = React.useState('upload');
  const [raw, setRaw] = React.useState<Raw | null>(null);
  const [mapping, setMapping] = React.useState<Record<string, FieldKey>>({});
  const [sheets, setSheets] = React.useState<string[]>([]);
  const [file, setFile] = React.useState<File | null>(null);
  const [paste, setPaste] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [sheetUrl, setSheetUrl] = React.useState('');
  const [sheetInfo, setSheetInfo] = React.useState<{ spreadsheetId: string; title: string; sheets: { title: string }[] } | null>(null);
  const [group, setGroup] = React.useState('');
  const [groupName, setGroupName] = React.useState('');
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => api.groups(), enabled: tab === 'contacts' });
  const analysis = React.useMemo(() => analyzeRecipients(value), [value]);

  const emailKey = React.useMemo(() => Object.entries(mapping).find(([, v]) => v === 'email')?.[0], [mapping]);
  const suppressed = useQuery({
    queryKey: ['suppressed', analysis.valid.length, analysis.valid[0]?.email, analysis.valid[analysis.valid.length - 1]?.email],
    queryFn: async () => (analysis.valid.length ? (await api.checkSuppressed(analysis.valid.map((r) => r.email))).suppressed : []),
    enabled: analysis.valid.length > 0, staleTime: 60_000,
  });

  function load(r: Raw, append = true) {
    const m = guessMapping(r.headers);
    setRaw(r); setMapping(m);
    const list = rowsToRecipients(r.rows, m);
    onChange(append ? [...value, ...list] : list);
    if (!Object.values(m).includes('email')) toast.error('No email column detected. Choose which column holds the email addresses below.');
  }
  const remap = (header: string, key: FieldKey) => {
    if (!raw) return;
    const next = { ...mapping };
    if (key === 'email') for (const h of Object.keys(next)) if (next[h] === 'email') next[h] = 'custom';
    next[header] = key; setMapping(next);
    onChange(rowsToRecipients(raw.rows, next));
  };

  async function parseFile(f: File, sheet?: string) {
    setBusy(true);
    try {
      const ext = f.name.split('.').pop()?.toLowerCase();
      if (ext === 'xlsx') {
        const names = await readSheetNames(f); setSheets(names);
        const table = await readXlsxFile(f, { sheet: sheet ?? names[0] });
        const rows = normaliseRows(table as unknown[][]);
        load({ headers: (rows as any)._h, rows, source: `${f.name}${names.length > 1 ? ` › ${sheet ?? names[0]}` : ''}` }, false);
      } else if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
        const text = await f.text();
        const res = Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: true });
        const rows = normaliseRows(res.data);
        load({ headers: (rows as any)._h, rows, source: f.name }, false);
      } else toast.error('Please choose a .csv or .xlsx file. For .xls, use Excel → Save As → CSV UTF-8.');
    } catch (e) { toast.error(`Could not read the file: ${errMsg(e)}`); } finally { setBusy(false); }
  }

  async function findSheet() {
    setBusy(true);
    try { setSheetInfo(await api.sheetsInfo(sheetUrl)); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  }
  async function loadSheet(title: string) {
    if (!sheetInfo) return;
    setBusy(true);
    try {
      const v = await api.sheetsValues(sheetInfo.spreadsheetId, title);
      load({ headers: v.headers, rows: v.rows, source: `${sheetInfo.title} › ${title}` }, false);
      if (v.truncated) toast.error('Only the first 5000 rows were imported.');
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  }
  async function loadContacts() {
    setBusy(true);
    try {
      const rows = group ? (await api.groupContacts(group)).rows : (await api.contacts({ limit: 200 })).rows;
      const list: RecipientInput[] = rows.filter((c: any) => c.subscription_status === 'subscribed').map((c: any) => ({
        email: c.email, first_name: c.first_name ?? undefined, last_name: c.last_name ?? undefined, company: c.company ?? undefined,
        website: c.website ?? undefined, position: c.position ?? undefined, fields: c.custom_fields ?? undefined, contact_id: c.id,
      }));
      onChange([...value, ...list]); toast.success(`Added ${list.length} subscribed contacts`);
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  }
  async function saveGroup() {
    if (!groupName.trim()) return;
    setBusy(true);
    try {
      const g = (await api.createGroup({ name: groupName.trim() })).group;
      const r = await api.importContacts(analysis.valid, g.id, 'campaign recipient list');
      toast.success(`Saved group "${g.name}" (${r.inserted} new, ${r.updated} updated)`); setGroupName('');
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  }

  const supp = new Set(suppressed.data ?? []);
  const eligible = analysis.valid.filter((r) => !supp.has(r.email)).length;

  return (
    <div className="space-y-4">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="upload"><Upload className="h-3.5 w-3.5" /> Upload CSV / Excel</TabsTrigger>
          <TabsTrigger value="sheet"><Sheet className="h-3.5 w-3.5" /> Google Sheet</TabsTrigger>
          <TabsTrigger value="paste"><FileText className="h-3.5 w-3.5" /> Paste / type</TabsTrigger>
          <TabsTrigger value="contacts"><Users className="h-3.5 w-3.5" /> Contacts &amp; groups</TabsTrigger>
        </TabsList>

        <TabsContent value="upload" className="space-y-3">
          <label onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) { setFile(f); parseFile(f); } }}
            className="flex cursor-pointer flex-col items-center gap-1 rounded-lg border-2 border-dashed border-primary/50 bg-primary/5 px-4 py-8 text-center transition-colors hover:bg-primary/10 focus-within:ring-2 focus-within:ring-ring">
            <FileSpreadsheet className="h-6 w-6 text-primary" />
            <span className="text-sm"><b className="text-primary">Drop a CSV or Excel file here</b> or click to choose</span>
            <span className="text-xs text-muted-foreground">First row = column names (Email, FirstName, Company…). One row per person. Excel: .xlsx. {busy && 'Reading…'}</span>
            <input type="file" accept=".csv,.tsv,.txt,.xlsx" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); parseFile(f); } e.target.value = ''; }} />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => downloadBlob(new Blob(['Email,FirstName,LastName,Company,Website,Position,Notes\nali@example.com,Ali,Khan,Acme Digital,acme.example.com,Founder,Met at the SEO meetup\nsara@example.com,Sara,,Beta Media,betamedia.example.com,Editor,Sells guest posts\n'], { type: 'text/csv' }), 'mailblaster-sample.csv')}>Download sample CSV</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => { onChange(SAMPLE); setRaw(null); }}>Try with sample rows</Button>
            {sheets.length > 1 && file && <Select className="h-8 w-48 text-xs" value={raw?.source.split(' › ')[1] ?? sheets[0]} onChange={(e) => parseFile(file, e.target.value)} aria-label="Worksheet">{sheets.map((s) => <option key={s}>{s}</option>)}</Select>}
          </div>
        </TabsContent>

        <TabsContent value="sheet" className="space-y-3">
          <Alert tone="info">Needs the optional <b>Google Sheets (read-only)</b> permission. Enable it in Settings → Account &amp; Integrations. You can import any spreadsheet your Google account can open.</Alert>
          <div className="flex gap-2"><Input placeholder="Paste the Google Sheets URL" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} aria-label="Spreadsheet URL" /><Button type="button" variant="secondary" loading={busy} onClick={findSheet} disabled={!sheetUrl}>Find sheets</Button></div>
          {sheetInfo && <Field label={`Worksheet in “${sheetInfo.title}”`}><div className="flex flex-wrap gap-2">{sheetInfo.sheets.map((s) => <Button key={s.title} type="button" variant="outline" size="sm" onClick={() => loadSheet(s.title)}>{s.title}</Button>)}</div></Field>}
        </TabsContent>

        <TabsContent value="paste" className="space-y-3">
          <Textarea rows={5} placeholder={'ali@example.com, sara@example.com\nJohn Smith <john@example.com>'} value={paste} onChange={(e) => setPaste(e.target.value)} aria-label="Email addresses" />
          <Button type="button" variant="secondary" disabled={!paste.trim()} onClick={() => { onChange([...value, ...parsePastedList(paste)]); setPaste(''); setRaw(null); }}>Add to list</Button>
          <p className="text-xs text-muted-foreground">Separate by comma, semicolon or new line. Each address becomes its own recipient and its own email: nobody is ever put in To/BCC together.</p>
        </TabsContent>

        <TabsContent value="contacts" className="space-y-3">
          <div className="flex flex-wrap gap-2"><Select className="w-64" value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Group"><option value="">Most recent 200 subscribed contacts</option>{groups.data?.groups.map((g: any) => <option key={g.id} value={g.id}>{g.name}{g.is_segment ? ' (segment)' : ''}</option>)}</Select><Button type="button" variant="secondary" loading={busy} onClick={loadContacts}>Add contacts</Button></div>
          <p className="text-xs text-muted-foreground">Unsubscribed and cleaned contacts are never added.</p>
        </TabsContent>
      </Tabs>

      {raw && (
        <div className="rounded-lg border border-border p-3">
          <p className="mb-2 text-sm font-medium">Map columns <span className="font-normal text-muted-foreground">· {raw.source} · {raw.rows.length} rows</span></p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {raw.headers.map((h) => (
              <div key={h} className="flex items-center gap-2"><span className="w-28 truncate text-xs text-muted-foreground" title={h}>{h}</span>
                <Select className="h-8 text-xs" value={mapping[h]} onChange={(e) => remap(h, e.target.value as FieldKey)} aria-label={`Map column ${h}`}>{Object.entries(FIELD_LABELS).map(([k, l]) => <option key={k} value={k}>{k === 'custom' ? `Custom field: {{${h}}}` : l}</option>)}</Select></div>
            ))}
          </div>
          {!emailKey && <Alert tone="error" className="mt-3">Pick the column that contains email addresses.</Alert>}
        </div>
      )}

      {value.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="green">{analysis.valid.length} valid</Badge>
            {analysis.invalid.length > 0 && <Badge tone="red">{analysis.invalid.length} invalid</Badge>}
            {analysis.duplicates.length > 0 && <Badge tone="amber">{analysis.duplicates.length} duplicates</Badge>}
            {supp.size > 0 && <Badge tone="amber">{supp.size} suppressed / unsubscribed (excluded)</Badge>}
            <Badge tone="indigo">{eligible} will be emailed individually</Badge>
            <div className="ml-auto flex gap-2">
              {(analysis.invalid.length > 0 || analysis.duplicates.length > 0) && <Button type="button" size="sm" variant="outline" onClick={() => onChange(analysis.valid)}>Remove invalid &amp; duplicates</Button>}
              <Button type="button" size="sm" variant="ghost" onClick={() => { onChange([]); setRaw(null); }}><Trash2 className="h-3.5 w-3.5" /> Clear</Button>
            </div>
          </div>
          {analysis.invalid.length > 0 && <p className="text-xs text-rose-300">Invalid: {analysis.invalid.slice(0, 5).map((r) => r.email || '(empty)').join(', ')}{analysis.invalid.length > 5 ? '…' : ''} (skipped automatically)</p>}
          <div className="max-h-64 overflow-auto rounded-lg border border-border">
            <Table><THead><TR><TH>Email</TH><TH>First</TH><TH>Last</TH><TH>Company</TH><TH>Website</TH><TH className="w-8" /></TR></THead>
              <TBody>{value.slice(0, 100).map((r, i) => (
                <TR key={i}><TD className={!analysis.valid.includes(r) && !analysis.valid.some((v) => v.email === r.email.trim().toLowerCase()) ? 'text-rose-300' : supp.has(r.email) ? 'text-amber-300 line-through' : ''}>{r.email}</TD><TD>{r.first_name}</TD><TD>{r.last_name}</TD><TD>{r.company}</TD><TD>{r.website}</TD>
                  <TD><button aria-label={`Remove ${r.email}`} onClick={() => onChange(value.filter((_, j) => j !== i))}><X className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" /></button></TD></TR>))}</TBody></Table>
          </div>
          {value.length > 100 && <p className="text-xs text-muted-foreground">Showing the first 100 of {value.length} rows.</p>}
          <div className="flex flex-wrap items-center gap-2"><Input className="max-w-xs" placeholder="Save these recipients as a group…" value={groupName} onChange={(e) => setGroupName(e.target.value)} aria-label="Group name" /><Button type="button" variant="outline" size="sm" loading={busy} disabled={!groupName.trim() || !analysis.valid.length} onClick={saveGroup}>Save group</Button></div>
        </div>
      )}
    </div>
  );
}
