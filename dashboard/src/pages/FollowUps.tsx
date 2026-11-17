import * as React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Repeat } from 'lucide-react';
import type { FollowUpStepInput } from '@mailblaster/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, PageHeader, Switch, Table, TBody, TD, TH, THead, TR } from '@/components/ui';
import { FollowUpEditor } from '@/components/composer/FollowUpEditor';
import { StatusBadge } from '@/components/StatusBadge';
import { errMsg, useToast } from '@/components/toast';
import { STANDARD_VARIABLES } from '@mailblaster/shared';

export default function FollowUps() {
  const { me, refreshMe } = useAuth(); const toast = useToast(); const qc = useQueryClient();
  const [steps, setSteps] = React.useState<FollowUpStepInput[]>((me!.settings.default_followups as FollowUpStepInput[]) ?? []);
  const save = useMutation({ mutationFn: () => api.updateSettings({ default_followups: steps as any }), onSuccess: () => { toast.success('Default follow-ups saved'); refreshMe(); }, onError: (e) => toast.error(errMsg(e)) });
  const camps = useQuery({ queryKey: ['campaigns', 'followups'], queryFn: () => api.listCampaigns({ limit: 100 }), refetchInterval: 15_000 });
  const toggle = useMutation({ mutationFn: (v: { id: string; on: boolean }) => api.setFollowUps(v.id, v.on), onSuccess: () => qc.invalidateQueries({ queryKey: ['campaigns'] }), onError: (e) => toast.error(errMsg(e)) });
  const rows = (camps.data?.rows ?? []).filter((c) => c.status !== 'draft');
  return (
    <>
      <PageHeader title="Follow-ups" description="Automatic follow-ups run on the same persistent cloud scheduler as the first email and stop the moment someone replies, unsubscribes or bounces." />
      <Alert tone="info" className="mb-6" title="How replies are detected">Gmail "send" access alone cannot see your inbox. To stop follow-ups automatically when someone replies, enable the optional <b>reply detection</b> permission in <Link className="underline" to="/settings/account">Account &amp; Integrations</Link>. Without it, follow-ups still stop on unsubscribe, bounce (if detectable) and manual disable, but a reply cannot be seen.</Alert>
      <Card className="mb-6">
        <CardHeader><CardTitle>Default stages for new campaigns</CardTitle><CardDescription>Used as the starting point in every new campaign (you can still change them per campaign).</CardDescription></CardHeader>
        <CardContent className="space-y-4"><FollowUpEditor steps={steps} onChange={setSteps} variables={[...STANDARD_VARIABLES]} /><Button loading={save.isPending} onClick={() => save.mutate()}>Save defaults</Button></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Campaign follow-up status</CardTitle></CardHeader>
        {rows.length === 0 ? <EmptyState icon={<Repeat className="h-5 w-5" />} title="No launched campaigns yet" /> : (
          <Table><THead><TR><TH>Campaign</TH><TH>Status</TH><TH className="text-right">Follow-ups sent</TH><TH className="text-right">Replied (stopped)</TH><TH>Follow-ups on</TH></TR></THead>
            <TBody>{rows.map((c) => (<TR key={c.id}><TD><Link className="font-medium hover:underline" to={`/campaigns/${c.id}`}>{c.name}</Link></TD><TD><StatusBadge status={c.status} /></TD><TD className="text-right tabular-nums">{c.follow_ups_sent}</TD><TD className="text-right tabular-nums">{c.replied}</TD>
              <TD><Switch checked={c.follow_ups_enabled} disabled={['cancelled', 'failed'].includes(c.status)} onCheckedChange={(on) => toggle.mutate({ id: c.id, on })} aria-label={`Follow-ups for ${c.name}`} /></TD></TR>))}</TBody></Table>)}
      </Card>
    </>
  );
}
