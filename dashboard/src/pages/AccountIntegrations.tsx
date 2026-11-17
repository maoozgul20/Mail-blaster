import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, Mail, Plug, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
import { SCOPE_GROUPS, type ScopeGroup, type ConnectedAccount } from '@mailblaster/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, PageHeader, Select } from '@/components/ui';
import { StatusBadge } from '@/components/StatusBadge';
import { errMsg, useToast } from '@/components/toast';
import { fmtDate } from '@/lib/utils';

const ERRORS: Record<string, string> = {
  access_denied: 'You declined access on the Google screen.', send_permission_not_granted: 'The "send email" permission is required. Please tick it on the Google screen.',
  no_refresh_token: 'Google did not issue a long-lived token. Remove MailBlaster at myaccount.google.com/permissions and connect again.', exchange_failed: 'Could not complete the Google sign-in. Check the OAuth credentials in your Worker secrets.',
  no_email: 'Google did not share your email address.',
};

export function AccountsPanel() {
  const { me, refreshMe } = useAuth(); const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [groups, setGroups] = React.useState<Record<ScopeGroup, boolean>>({ send: true, read: false, compose: false, sheets: false });
  React.useEffect(() => {
    const c = params.get('connected'); const e = params.get('oauth_error');
    if (c) { toast.success(`Connected ${c}`); refreshMe(); }
    if (e) toast.error(ERRORS[e] ?? `Google sign-in failed (${e})`);
    if (c || e) { params.delete('connected'); params.delete('oauth_error'); params.delete('from'); setParams(params, { replace: true }); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = useMutation({
    mutationFn: async (a?: ConnectedAccount) => {
      const chosen = (Object.keys(groups) as ScopeGroup[]).filter((g) => groups[g] || (a && a.scopes.includes(SCOPE_GROUPS[g].scope)));
      const { url } = await api.startOAuth(chosen, 'dashboard', a?.email);
      window.location.href = url;
    }, onError: (e) => toast.error(errMsg(e)),
  });
  const disconnect = useMutation({ mutationFn: (id: string) => api.disconnectAccount(id), onSuccess: () => { toast.success('Disconnected and token revoked'); refreshMe(); }, onError: (e) => toast.error(errMsg(e)) });
  const setConc = useMutation({ mutationFn: (v: { id: string; n: number }) => api.updateAccount(v.id, { max_concurrent: v.n }), onSuccess: () => refreshMe(), onError: (e) => toast.error(errMsg(e)) });
  const accounts = me?.accounts.filter((a) => a.status !== 'disconnected') ?? [];

  return (
    <div className="space-y-6">
      {!me?.google_configured && <Alert tone="error" title="Google OAuth is not configured">Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as Worker secrets (see docs/GOOGLE_OAUTH.md), then reload.</Alert>}
      <Alert tone="warn" title="Google “Testing” mode">While your Google Cloud OAuth app is in <b>Testing</b> publishing status, Google expires the authorization after <b>7 days</b> for apps that use Gmail scopes. When it expires, sending pauses and a banner appears here: just click <b>Reauthorize</b>. Publishing/verifying the app removes the limit (see docs/GOOGLE_OAUTH.md). The app also shows an “unverified app” screen: use <i>Advanced → continue</i> with a test user you added.</Alert>

      {accounts.map((a) => (
        <Card key={a.id}>
          <CardHeader className="flex-row flex-wrap items-center gap-3"><Mail className="h-5 w-5 text-primary" /><CardTitle>{a.email}</CardTitle><StatusBadge status={a.status} />{a.status === 'active' && <CheckCircle2 className="h-4 w-4 text-emerald-400" />}</CardHeader>
          <CardContent className="space-y-4 text-sm">
            {a.status === 'reauth_required' && <Alert tone="warn" title="Authorization expired or revoked">{a.last_error ?? 'Reconnect to resume sending. Queued emails are kept and continue automatically.'}</Alert>}
            {a.blocked_until && new Date(a.blocked_until) > new Date() && <Alert tone="warn" title="Gmail quota reached">Sending is paused until {fmtDate(a.blocked_until)}. {a.blocked_reason}</Alert>}
            <div className="flex flex-wrap gap-2">{(Object.keys(SCOPE_GROUPS) as ScopeGroup[]).map((g) => <Badge key={g} tone={a.scopes.includes(SCOPE_GROUPS[g].scope) ? 'green' : 'neutral'}>{a.scopes.includes(SCOPE_GROUPS[g].scope) ? '✓' : '○'} {SCOPE_GROUPS[g].title.replace(' (optional)', '')}</Badge>)}</div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div><p className="text-xs text-muted-foreground">Gmail daily cap (provider limit)</p><p>{a.daily_cap} emails / 24 h <span className="text-xs text-muted-foreground">(personal Gmail ≈ 500, Workspace ≈ 2,000; campaign limits can never exceed this)</span></p></div>
              <div><p className="text-xs text-muted-foreground">Next send slot</p><p>{a.next_send_at ? fmtDate(a.next_send_at) : 'Immediately'}</p></div>
              <div><p className="text-xs text-muted-foreground">Max concurrent sends</p><Select className="h-8 w-24" value={a.max_concurrent} onChange={(e) => setConc.mutate({ id: a.id, n: +e.target.value })} aria-label="Max concurrent sends">{[1, 2, 3].map((n) => <option key={n}>{n}</option>)}</Select></div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => connect.mutate(a)} loading={connect.isPending}><RefreshCw className="h-3.5 w-3.5" /> Reauthorize / change permissions</Button>
              <Button variant="outline" size="sm" onClick={() => { if (confirm(`Disconnect ${a.email}? Its running campaigns will be paused and the Google token revoked.`)) disconnect.mutate(a.id); }}><Trash2 className="h-3.5 w-3.5 text-rose-400" /> Disconnect</Button>
            </div>
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Plug className="h-4 w-4" /> {accounts.length ? 'Connect another Gmail account' : 'Connect your Gmail account'}</CardTitle>
          <CardDescription>Official Google OAuth 2.0. MailBlaster never sees your password and asks only for the permissions you tick.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          {(Object.keys(SCOPE_GROUPS) as ScopeGroup[]).map((g) => (
            <label key={g} className="flex items-start gap-3 rounded-lg border border-border/60 p-3 text-sm">
              <Checkbox className="mt-1" checked={groups[g]} disabled={g === 'send'} onChange={(e) => setGroups({ ...groups, [g]: e.target.checked })} />
              <span><b>{SCOPE_GROUPS[g].title}</b><span className="block text-xs text-muted-foreground">{SCOPE_GROUPS[g].description}</span><code className="text-[11px] text-muted-foreground">{SCOPE_GROUPS[g].scope}</code></span>
            </label>))}
          <Alert tone="info"><ShieldAlert className="mr-1 inline h-4 w-4" />Gmail "send" access alone cannot read your inbox, so it cannot detect replies. Reply and bounce detection is a separate, optional, <i>restricted</i> Google permission. For personal use in Testing mode it works for test users; a public production app needs Google's verification and security assessment.</Alert>
          <Button loading={connect.isPending} disabled={!me?.google_configured} onClick={() => connect.mutate(undefined)}>Continue with Google</Button>
        </CardContent>
      </Card>
    </div>
  );
}

export default function AccountIntegrations() {
  return (<><PageHeader title="Account & Integrations" description="Connect Gmail, choose permissions, and manage authorization." /><AccountsPanel /></>);
}
