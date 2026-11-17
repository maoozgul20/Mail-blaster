import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FolderPlus, Pencil, Plus, Search, Trash2, Upload, Users } from 'lucide-react';
import type { RecipientInput } from '@mailblaster/shared';
import { api } from '@/lib/api';
import { Alert, Badge, Button, Card, Checkbox, Dialog, DialogContent, EmptyState, Field, Input, PageHeader, Pagination, Select, Skeleton, Table, TBody, TD, TH, THead, TR, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { RecipientImport } from '@/components/composer/RecipientImport';
import { errMsg, useToast } from '@/components/toast';
import { downloadBlob, fmtDate } from '@/lib/utils';

const LIMIT = 50;
const STATUS_TONE: Record<string, any> = { subscribed: 'green', unsubscribed: 'amber', cleaned: 'red' };

function ContactForm({ contact, onDone }: { contact?: any; onDone: () => void }) {
  const toast = useToast(); const qc = useQueryClient();
  const [f, setF] = React.useState({ email: contact?.email ?? '', first_name: contact?.first_name ?? '', last_name: contact?.last_name ?? '', company: contact?.company ?? '', website: contact?.website ?? '', position: contact?.position ?? '', tags: (contact?.tags ?? []).join(', '), subscription_status: contact?.subscription_status ?? 'subscribed', consent_source: contact?.consent_source ?? 'manual entry', consent_notes: contact?.consent_notes ?? '' });
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => { const body = { ...f, tags: f.tags.split(',').map((t: string) => t.trim()).filter(Boolean), first_name: f.first_name || null, last_name: f.last_name || null, company: f.company || null, website: f.website || null, position: f.position || null, consent_notes: f.consent_notes || null }; return contact ? api.updateContact(contact.id, body) : api.createContact(body); },
    onSuccess: () => { toast.success(contact ? 'Contact updated' : 'Contact added'); qc.invalidateQueries({ queryKey: ['contacts'] }); onDone(); }, onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      <Field label="Email"><Input type="email" required value={f.email} onChange={set('email')} /></Field>
      <div className="grid grid-cols-2 gap-3"><Field label="First name"><Input value={f.first_name} onChange={set('first_name')} /></Field><Field label="Last name"><Input value={f.last_name} onChange={set('last_name')} /></Field>
        <Field label="Company"><Input value={f.company} onChange={set('company')} /></Field><Field label="Website"><Input value={f.website} onChange={set('website')} /></Field>
        <Field label="Position"><Input value={f.position} onChange={set('position')} /></Field><Field label="Tags (comma separated)"><Input value={f.tags} onChange={set('tags')} /></Field></div>
      <div className="grid grid-cols-2 gap-3"><Field label="Subscription"><Select value={f.subscription_status} onChange={set('subscription_status')}><option value="subscribed">Subscribed</option><option value="unsubscribed">Unsubscribed</option><option value="cleaned">Cleaned (bad address)</option></Select></Field>
        <Field label="Consent source" hint="How/where this person agreed to hear from you"><Input value={f.consent_source} onChange={set('consent_source')} /></Field></div>
      <Field label="Consent notes"><Input value={f.consent_notes} onChange={set('consent_notes')} /></Field>
      <div className="flex justify-end"><Button type="submit" loading={m.isPending}>{contact ? 'Save' : 'Add contact'}</Button></div>
    </form>
  );
}

export default function Contacts() {
  const qc = useQueryClient(); const toast = useToast();
  const [search, setSearch] = React.useState(''); const [tag, setTag] = React.useState(''); const [status, setStatus] = React.useState(''); const [group, setGroup] = React.useState('');
  const [offset, setOffset] = React.useState(0);
  const [sel, setSel] = React.useState<Set<string>>(new Set());
  const [edit, setEdit] = React.useState<any | 'new' | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [list, setList] = React.useState<RecipientInput[]>([]);
  const [importGroup, setImportGroup] = React.useState('');
  const [newGroup, setNewGroup] = React.useState({ name: '', segment: false, tags: '', company: '' });
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => api.groups() });
  const q = useQuery({ queryKey: ['contacts', search, tag, status, group, offset], queryFn: () => api.contacts({ search, tag, status, group, limit: LIMIT, offset }), placeholderData: (p) => p });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['contacts'] }); qc.invalidateQueries({ queryKey: ['groups'] }); };
  const rows = q.data?.rows ?? [];
  const allSel = rows.length > 0 && rows.every((r: any) => sel.has(r.id));

  async function doImport() {
    const valid = list.filter((r) => r.email);
    try { const r = await api.importContacts(valid, importGroup || null, 'contacts import'); toast.success(`${r.inserted} added, ${r.updated} updated, ${r.invalid} invalid, ${r.duplicates} duplicates skipped`); setImporting(false); setList([]); refresh(); } catch (e) { toast.error(errMsg(e)); }
  }
  async function createGroup() {
    try {
      await api.createGroup({ name: newGroup.name, is_segment: newGroup.segment, ...(newGroup.segment ? { segment_filter: { tags: newGroup.tags.split(',').map((t) => t.trim()).filter(Boolean), company: newGroup.company } } : {}) });
      setNewGroup({ name: '', segment: false, tags: '', company: '' }); refresh(); toast.success('Group created');
    } catch (e) { toast.error(errMsg(e)); }
  }

  return (
    <>
      <PageHeader title="Contacts" description="Your address book with consent records. Unsubscribed and cleaned contacts are never emailed."
        actions={<><Button variant="outline" onClick={async () => { try { downloadBlob(await api.downloadCsv('/api/contacts/export.csv'), 'contacts.csv'); } catch (e) { toast.error(errMsg(e)); } }}><Download className="h-4 w-4" /> Export</Button><Button variant="outline" onClick={() => setImporting(true)}><Upload className="h-4 w-4" /> Import</Button><Button onClick={() => setEdit('new')}><Plus className="h-4 w-4" /> Add contact</Button></>} />
      <Tabs defaultValue="contacts">
        <TabsList><TabsTrigger value="contacts"><Users className="h-3.5 w-3.5" /> All contacts</TabsTrigger><TabsTrigger value="groups"><FolderPlus className="h-3.5 w-3.5" /> Groups &amp; segments</TabsTrigger></TabsList>
        <TabsContent value="contacts">
          <Card>
            <div className="flex flex-wrap items-center gap-3 border-b border-border/60 p-4">
              <div className="relative w-full max-w-xs"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input className="pl-9" placeholder="Search name, email, company" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} aria-label="Search contacts" /></div>
              <Input className="w-32" placeholder="Tag" value={tag} onChange={(e) => { setTag(e.target.value); setOffset(0); }} aria-label="Filter by tag" />
              <Select className="w-40" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }} aria-label="Subscription status"><option value="">Any status</option><option value="subscribed">Subscribed</option><option value="unsubscribed">Unsubscribed</option><option value="cleaned">Cleaned</option></Select>
              <Select className="w-44" value={group} onChange={(e) => { setGroup(e.target.value); setOffset(0); }} aria-label="Group"><option value="">All groups</option>{groups.data?.groups.map((g: any) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select>
              {sel.size > 0 && (<div className="ml-auto flex items-center gap-2"><span className="text-sm text-muted-foreground">{sel.size} selected</span>
                <Select className="h-8 w-40 text-xs" value="" onChange={async (e) => { if (!e.target.value) return; try { await api.addGroupMembers(e.target.value, [...sel]); toast.success('Added to group'); setSel(new Set()); refresh(); } catch (er) { toast.error(errMsg(er)); } }} aria-label="Add to group"><option value="">Add to group…</option>{groups.data?.groups.filter((g: any) => !g.is_segment).map((g: any) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select>
                <Button size="sm" variant="destructive" onClick={async () => { if (!confirm(`Delete ${sel.size} contacts?`)) return; try { await api.deleteContacts([...sel]); setSel(new Set()); refresh(); toast.success('Deleted'); } catch (e) { toast.error(errMsg(e)); } }}><Trash2 className="h-3.5 w-3.5" /> Delete</Button></div>)}
            </div>
            {q.isLoading ? <div className="p-4"><Skeleton className="h-40" /></div> : rows.length === 0 ? <EmptyState icon={<Users className="h-5 w-5" />} title="No contacts yet">Import a CSV/Excel file or add people one by one. Contacts you email from campaigns can be saved as groups.</EmptyState> : (
              <Table><THead><TR><TH className="w-8"><Checkbox checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(rows.map((r: any) => r.id)))} aria-label="Select all" /></TH><TH>Email</TH><TH>Name</TH><TH>Company</TH><TH>Tags</TH><TH>Status</TH><TH>Consent</TH><TH className="w-20" /></TR></THead>
                <TBody>{rows.map((c: any) => (
                  <TR key={c.id}><TD><Checkbox checked={sel.has(c.id)} onChange={() => { const n = new Set(sel); n.has(c.id) ? n.delete(c.id) : n.add(c.id); setSel(n); }} aria-label={`Select ${c.email}`} /></TD>
                    <TD className="font-medium">{c.email}</TD><TD>{[c.first_name, c.last_name].filter(Boolean).join(' ') || '—'}</TD><TD>{c.company ?? '—'}</TD>
                    <TD><div className="flex flex-wrap gap-1">{(c.tags ?? []).map((t: string) => <Badge key={t} tone="indigo">{t}</Badge>)}</div></TD>
                    <TD><Badge tone={STATUS_TONE[c.subscription_status]}>{c.subscription_status}</Badge></TD>
                    <TD className="text-xs text-muted-foreground">{c.consent_source ?? 'Not recorded'}{c.consent_at ? ` · ${fmtDate(c.consent_at, { time: false })}` : ''}</TD>
                    <TD><div className="flex"><Button variant="ghost" size="icon" aria-label="Edit" onClick={() => setEdit(c)}><Pencil className="h-4 w-4" /></Button><Button variant="ghost" size="icon" aria-label="Delete" onClick={async () => { if (!confirm(`Delete ${c.email}?`)) return; try { await api.deleteContacts([c.id]); refresh(); } catch (e) { toast.error(errMsg(e)); } }}><Trash2 className="h-4 w-4 text-rose-400" /></Button></div></TD></TR>))}</TBody></Table>)}
            {q.data && q.data.total > 0 && <Pagination total={q.data.total} limit={LIMIT} offset={offset} onChange={setOffset} />}
          </Card>
        </TabsContent>
        <TabsContent value="groups" className="space-y-4">
          <Card className="p-5"><h3 className="mb-3 font-semibold">New group or segment</h3>
            <div className="grid gap-3 sm:grid-cols-4"><Field label="Name"><Input value={newGroup.name} onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })} /></Field>
              <Field label="Type"><Select value={newGroup.segment ? 'seg' : 'static'} onChange={(e) => setNewGroup({ ...newGroup, segment: e.target.value === 'seg' })}><option value="static">Group (manual members)</option><option value="seg">Segment (dynamic filter)</option></Select></Field>
              {newGroup.segment && <><Field label="Has any tag"><Input value={newGroup.tags} onChange={(e) => setNewGroup({ ...newGroup, tags: e.target.value })} placeholder="lead, vip" /></Field><Field label="Company contains"><Input value={newGroup.company} onChange={(e) => setNewGroup({ ...newGroup, company: e.target.value })} /></Field></>}
            </div><Button className="mt-3" disabled={!newGroup.name.trim()} onClick={createGroup}>Create</Button></Card>
          <Card>{groups.data?.groups.length === 0 ? <EmptyState title="No groups yet" /> : (
            <Table><THead><TR><TH>Name</TH><TH>Type</TH><TH>Filter</TH><TH className="w-12" /></TR></THead><TBody>{groups.data?.groups.map((g: any) => (
              <TR key={g.id}><TD className="font-medium">{g.name}</TD><TD><Badge tone={g.is_segment ? 'violet' : 'neutral'}>{g.is_segment ? 'Segment' : 'Group'}</Badge></TD><TD className="text-xs text-muted-foreground">{g.is_segment ? JSON.stringify(g.segment_filter) : 'manual'}</TD>
                <TD><Button variant="ghost" size="icon" aria-label="Delete group" onClick={async () => { if (confirm(`Delete "${g.name}"? Contacts are kept.`)) { await api.deleteGroup(g.id); refresh(); } }}><Trash2 className="h-4 w-4 text-rose-400" /></Button></TD></TR>))}</TBody></Table>)}</Card>
        </TabsContent>
      </Tabs>

      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}><DialogContent title={edit === 'new' ? 'Add contact' : 'Edit contact'}>{edit && <ContactForm contact={edit === 'new' ? undefined : edit} onDone={() => setEdit(null)} />}</DialogContent></Dialog>
      <Dialog open={importing} onOpenChange={setImporting}><DialogContent title="Import contacts" description="CSV, Excel, Google Sheet or pasted list. Duplicates are merged by email." className="max-w-3xl">
        <div className="space-y-4"><Alert tone="info">By importing you confirm these people agreed to receive your email (or you have another lawful basis). The source is stored as their consent record.</Alert>
          <RecipientImport value={list} onChange={setList} />
          <Field label="Also add to group"><Select value={importGroup} onChange={(e) => setImportGroup(e.target.value)}><option value="">No group</option>{groups.data?.groups.filter((g: any) => !g.is_segment).map((g: any) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select></Field>
          <div className="flex justify-end"><Button disabled={!list.length} onClick={doImport}>Import {list.length} rows</Button></div></div></DialogContent></Dialog>
    </>
  );
}
