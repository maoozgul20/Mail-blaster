import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, FileText, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge, Button, Card, Dialog, DialogContent, EmptyState, Field, Input, PageHeader, Select, Skeleton } from '@/components/ui';
import { RichEditor } from '@/components/composer/RichEditor';
import { EmailPreview } from '@/components/composer/EmailPreview';
import { errMsg, useToast } from '@/components/toast';
import { STANDARD_VARIABLES } from '@mailblaster/shared';

function Editor({ t, onDone }: { t: any; onDone: () => void }) {
  const toast = useToast(); const qc = useQueryClient();
  const [f, setF] = React.useState({ name: t.name ?? '', category: t.category ?? 'General', subject: t.subject ?? '', body_html: t.body_html ?? '' });
  const m = useMutation({ mutationFn: () => (t.id ? api.updateTemplate(t.id, f) : api.createTemplate(f)), onSuccess: () => { toast.success('Template saved'); qc.invalidateQueries({ queryKey: ['templates'] }); onDone(); }, onError: (e) => toast.error(errMsg(e)) });
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3"><Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label="Category"><Input value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} /></Field></div>
        <Field label="Subject"><Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
        <RichEditor value={f.body_html} onChange={(h) => setF((x) => ({ ...x, body_html: h }))} variables={[...STANDARD_VARIABLES]} minHeight={200} />
        <div className="flex justify-end"><Button loading={m.isPending} disabled={!f.name.trim()} onClick={() => m.mutate()}>Save template</Button></div>
      </div>
      <div><h4 className="mb-2 text-sm font-semibold">Preview</h4><EmailPreview subject={f.subject} html={f.body_html} recipients={[]} /></div>
    </div>
  );
}

export default function Templates() {
  const qc = useQueryClient(); const toast = useToast();
  const [search, setSearch] = React.useState(''); const [cat, setCat] = React.useState('');
  const [edit, setEdit] = React.useState<any | null>(null);
  const q = useQuery({ queryKey: ['templates', search, cat], queryFn: () => api.templates({ search, category: cat }) });
  const all = useQuery({ queryKey: ['templates'], queryFn: () => api.templates() });
  const cats = [...new Set(all.data?.templates.map((t) => t.category) ?? [])];
  return (
    <>
      <PageHeader title="Templates" description="Reusable subjects and messages with personalization variables." actions={<Button onClick={() => setEdit({})}><Plus className="h-4 w-4" /> New template</Button>} />
      <div className="mb-4 flex flex-wrap gap-3">
        <div className="relative w-full max-w-xs"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input className="pl-9" placeholder="Search templates" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search templates" /></div>
        <Select className="w-48" value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category"><option value="">All categories</option>{cats.map((c) => <option key={c}>{c}</option>)}</Select>
      </div>
      {q.isLoading ? <Skeleton className="h-48" /> : q.data?.templates.length === 0 ? <Card><EmptyState icon={<FileText className="h-5 w-5" />} title="No templates found" /></Card> : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {q.data?.templates.map((t) => (
            <Card key={t.id} className="flex flex-col p-5">
              <div className="mb-2 flex items-start justify-between gap-2"><h3 className="font-semibold">{t.name}</h3><Badge tone={t.is_starter ? 'violet' : 'indigo'}>{t.category}</Badge></div>
              <p className="mb-1 truncate text-sm text-muted-foreground">Subject: {t.subject || '—'}</p>
              <p className="line-clamp-3 flex-1 text-sm text-muted-foreground">{t.body_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')}</p>
              <div className="mt-4 flex gap-1"><Button size="sm" variant="outline" onClick={() => setEdit(t)}><Pencil className="h-3.5 w-3.5" /> Edit</Button>
                <Button size="sm" variant="ghost" onClick={async () => { try { await api.duplicateTemplate(t.id); qc.invalidateQueries({ queryKey: ['templates'] }); toast.success('Duplicated'); } catch (e) { toast.error(errMsg(e)); } }}><Copy className="h-3.5 w-3.5" /> Duplicate</Button>
                <Button size="sm" variant="ghost" className="ml-auto" aria-label={`Delete ${t.name}`} onClick={async () => { if (!confirm('Delete this template?')) return; await api.deleteTemplate(t.id); qc.invalidateQueries({ queryKey: ['templates'] }); }}><Trash2 className="h-3.5 w-3.5 text-rose-400" /></Button></div>
            </Card>))}
        </div>)}
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}><DialogContent title={edit?.id ? 'Edit template' : 'New template'} className="max-w-5xl">{edit && <Editor t={edit} onDone={() => setEdit(null)} />}</DialogContent></Dialog>
    </>
  );
}
