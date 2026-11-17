import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldBan, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Input, PageHeader, Pagination, Skeleton, Table, TBody, TD, TH, THead, TR, Textarea } from '@/components/ui';
import { errMsg, useToast } from '@/components/toast';
import { fmtDate } from '@/lib/utils';

const TONE: Record<string, any> = { unsubscribed: 'amber', bounced: 'red', manual: 'neutral', complaint: 'red' };
const LIMIT = 50;

export default function Suppression() {
  const qc = useQueryClient(); const toast = useToast();
  const [search, setSearch] = React.useState(''); const [offset, setOffset] = React.useState(0); const [text, setText] = React.useState('');
  const q = useQuery({ queryKey: ['suppression', search, offset], queryFn: () => api.suppression({ search, limit: LIMIT, offset }), placeholderData: (p) => p });
  const add = useMutation({ mutationFn: () => api.addSuppression(text.split(/[\s,;]+/).filter(Boolean)), onSuccess: () => { toast.success('Added to the suppression list'); setText(''); qc.invalidateQueries({ queryKey: ['suppression'] }); }, onError: (e) => toast.error(errMsg(e)) });
  return (
    <>
      <PageHeader title="Suppression list" description="Addresses here are checked before EVERY send, in every campaign. Unsubscribes and permanent bounces are added automatically." />
      <Alert tone="info" className="mb-6">Removing an address only lifts the block in MailBlaster. Only do it if the person has explicitly asked to hear from you again.</Alert>
      <Card className="mb-6"><CardHeader><CardTitle>Add addresses</CardTitle></CardHeader><CardContent className="space-y-3"><Textarea rows={3} placeholder="one or more emails, separated by space, comma or new line" value={text} onChange={(e) => setText(e.target.value)} aria-label="Emails to suppress" /><Button loading={add.isPending} disabled={!text.trim()} onClick={() => add.mutate()}>Add to suppression list</Button></CardContent></Card>
      <Card>
        <div className="border-b border-border/60 p-4"><Input className="max-w-xs" placeholder="Search" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} aria-label="Search suppression list" /></div>
        {q.isLoading ? <div className="p-4"><Skeleton className="h-32" /></div> : q.data?.rows.length === 0 ? <EmptyState icon={<ShieldBan className="h-5 w-5" />} title="Nobody is suppressed" /> : (
          <Table><THead><TR><TH>Email</TH><TH>Reason</TH><TH>Source</TH><TH>Added</TH><TH className="w-12" /></TR></THead>
            <TBody>{q.data?.rows.map((r: any) => (<TR key={r.id}><TD className="font-medium">{r.email}</TD><TD><Badge tone={TONE[r.reason]}>{r.reason}</Badge></TD><TD className="text-sm text-muted-foreground">{r.source ?? '—'}</TD><TD className="text-xs text-muted-foreground">{fmtDate(r.created_at)}</TD>
              <TD><Button variant="ghost" size="icon" aria-label={`Remove ${r.email}`} onClick={async () => { if (!confirm(`Allow emails to ${r.email} again?`)) return; try { await api.removeSuppression(r.id); qc.invalidateQueries({ queryKey: ['suppression'] }); } catch (e) { toast.error(errMsg(e)); } }}><Trash2 className="h-4 w-4 text-rose-400" /></Button></TD></TR>))}</TBody></Table>)}
        {q.data && q.data.total > 0 && <Pagination total={q.data.total} limit={LIMIT} offset={offset} onChange={setOffset} />}
      </Card>
    </>
  );
}
