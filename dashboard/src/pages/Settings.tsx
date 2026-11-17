import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { Download, LogOut, Trash2 } from 'lucide-react';
import { WEEKDAYS, type UserSettings } from '@mailblaster/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, PageHeader, Select, Switch, Tabs, TabsContent, TabsList, TabsTrigger, Textarea } from '@/components/ui';
import { RichEditor } from '@/components/composer/RichEditor';
import { errMsg, useToast } from '@/components/toast';
import { AccountsPanel } from './AccountIntegrations';
import { browserTz, downloadBlob, timezones } from '@/lib/utils';
import { STANDARD_VARIABLES } from '@mailblaster/shared';

function useSave() {
  const { refreshMe } = useAuth(); const toast = useToast();
  return useMutation({ mutationFn: (p: Partial<UserSettings>) => api.updateSettings(p), onSuccess: () => { toast.success('Settings saved'); refreshMe(); }, onError: (e) => toast.error(errMsg(e)) });
}

export default function Settings() {
  const { me, signOut } = useAuth(); const toast = useToast(); const save = useSave();
  const [s, setS] = React.useState<UserSettings>(me!.settings);
  const set = (p: Partial<UserSettings>) => setS((x) => ({ ...x, ...p }));
  const [name, setName] = React.useState(me!.user.full_name ?? '');
  const [del, setDel] = React.useState('');

  return (
    <>
      <PageHeader title="Settings" description="Defaults for new campaigns, tracking, notifications and security." />
      <Tabs defaultValue="sending">
        <TabsList><TabsTrigger value="sending">Sending</TabsTrigger><TabsTrigger value="tracking">Tracking</TabsTrigger><TabsTrigger value="gmail">Gmail</TabsTrigger><TabsTrigger value="notifications">Notifications</TabsTrigger><TabsTrigger value="signature">Signature</TabsTrigger><TabsTrigger value="security">Security</TabsTrigger></TabsList>

        <TabsContent value="sending"><Card><CardHeader><CardTitle>Sending defaults</CardTitle><CardDescription>Each new campaign starts with these; you can change them per campaign. Gmail's own account limits always apply on top.</CardDescription></CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Daily sending limit"><Input type="number" min={1} max={2000} value={s.daily_limit} onChange={(e) => set({ daily_limit: +e.target.value })} /></Field>
              <Field label="Minimum interval (seconds)"><Input type="number" min={0} value={s.min_interval_seconds} onChange={(e) => set({ min_interval_seconds: +e.target.value })} /></Field>
              <Field label="Maximum interval (seconds)"><Input type="number" min={0} value={s.max_interval_seconds} onChange={(e) => set({ max_interval_seconds: +e.target.value })} /></Field>
            </div>
            <Field label="Time zone"><Select value={s.timezone} onChange={(e) => set({ timezone: e.target.value })}>{[...new Set([s.timezone, browserTz(), 'UTC', ...timezones()])].map((z) => <option key={z}>{z}</option>)}</Select></Field>
            <div className="space-y-2"><label className="flex items-center gap-3 text-sm"><Switch checked={s.business_hours.enabled} onCheckedChange={(v) => set({ business_hours: { ...s.business_hours, enabled: v } })} /> Business hours only</label>
              {s.business_hours.enabled && <div className="flex items-center gap-2 text-sm"><Input type="time" className="w-32" value={s.business_hours.start} onChange={(e) => set({ business_hours: { ...s.business_hours, start: e.target.value } })} /> to <Input type="time" className="w-32" value={s.business_hours.end} onChange={(e) => set({ business_hours: { ...s.business_hours, end: e.target.value } })} /></div>}
              <div className="flex flex-wrap gap-2" role="group" aria-label="Weekdays">{WEEKDAYS.map((d) => <button key={d.n} type="button" onClick={() => { const w = s.weekdays.includes(d.n) ? s.weekdays.filter((x) => x !== d.n) : [...s.weekdays, d.n].sort(); if (w.length) set({ weekdays: w }); }} className={`rounded-full border px-3 py-1 text-xs ${s.weekdays.includes(d.n) ? 'border-primary bg-primary/20' : 'border-border text-muted-foreground'}`}>{d.label}</button>)}</div></div>
            <Button loading={save.isPending} onClick={() => save.mutate({ daily_limit: s.daily_limit, min_interval_seconds: s.min_interval_seconds, max_interval_seconds: s.max_interval_seconds, timezone: s.timezone, business_hours: s.business_hours, weekdays: s.weekdays })}>Save sending settings</Button>
          </CardContent></Card></TabsContent>

        <TabsContent value="tracking"><Card><CardHeader><CardTitle>Tracking</CardTitle><CardDescription>Tracking is optional. Check your local law: some regions require consent or disclosure.</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <label className="flex items-center gap-3 text-sm"><Switch checked={s.track_opens} onCheckedChange={(v) => set({ track_opens: v })} /> Open tracking (invisible 1×1 pixel)</label>
            <label className="flex items-center gap-3 text-sm"><Switch checked={s.track_clicks} onCheckedChange={(v) => set({ track_clicks: v })} /> Click tracking (links are wrapped in signed redirects)</label>
            <label className="flex items-center gap-3 text-sm"><Switch checked={s.unsubscribe_footer} onCheckedChange={(v) => set({ unsubscribe_footer: v })} /> Add an unsubscribe link and List-Unsubscribe headers</label>
            <Field label="Unsubscribe link text"><Input value={s.unsubscribe_text} onChange={(e) => set({ unsubscribe_text: e.target.value })} /></Field>
            <Field label="Tracking disclosure (shown in the footer when tracking is on)"><Textarea rows={2} value={s.tracking_disclosure} onChange={(e) => set({ tracking_disclosure: e.target.value })} /></Field>
            <Alert tone="info">Open rates are approximate: image blocking hides opens, while Apple Mail Privacy Protection and some security scanners can produce opens you didn't earn. Hits within 8 seconds of sending are ignored as scanner prefetches.</Alert>
            <Button loading={save.isPending} onClick={() => save.mutate({ track_opens: s.track_opens, track_clicks: s.track_clicks, unsubscribe_footer: s.unsubscribe_footer, unsubscribe_text: s.unsubscribe_text, tracking_disclosure: s.tracking_disclosure })}>Save tracking settings</Button>
          </CardContent></Card></TabsContent>

        <TabsContent value="gmail"><AccountsPanel /></TabsContent>

        <TabsContent value="notifications"><Card><CardHeader><CardTitle>Notifications</CardTitle><CardDescription>Shown in the bell menu.</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            {([['campaign_completed', 'Campaign completed'], ['reply_received', 'Reply received'], ['failed_sending', 'Failed sending / bounces / reauthorization'], ['campaign_paused', 'Campaign paused']] as const).map(([k, l]) => (
              <label key={k} className="flex items-center gap-3 text-sm"><Switch checked={s.notifications[k] !== false} onCheckedChange={(v) => set({ notifications: { ...s.notifications, [k]: v } })} /> {l}</label>))}
            <Button loading={save.isPending} onClick={() => save.mutate({ notifications: s.notifications })}>Save notification settings</Button>
          </CardContent></Card></TabsContent>

        <TabsContent value="signature"><Card><CardHeader><CardTitle>Email signature</CardTitle><CardDescription>Appended to every email you send.</CardDescription></CardHeader>
          <CardContent className="space-y-4"><RichEditor value={s.signature_html} onChange={(h) => set({ signature_html: h })} variables={[...STANDARD_VARIABLES]} minHeight={140} /><Button loading={save.isPending} onClick={() => save.mutate({ signature_html: s.signature_html })}>Save signature</Button></CardContent></Card></TabsContent>

        <TabsContent value="security" className="space-y-4">
          <Card><CardHeader><CardTitle>Profile & sessions</CardTitle></CardHeader><CardContent className="space-y-4">
            <div className="flex flex-wrap items-end gap-3"><Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field><Button variant="secondary" onClick={async () => { try { await api.updateProfile(name); toast.success('Saved'); } catch (e) { toast.error(errMsg(e)); } }}>Save</Button></div>
            <p className="text-sm text-muted-foreground">Signed in as {me!.user.email}</p>
            <Button variant="outline" onClick={async () => { try { await api.signOutEverywhere(); } catch { /* token may already be invalid */ } await signOut(); }}><LogOut className="h-4 w-4" /> Sign out of all sessions</Button>
          </CardContent></Card>
          <Card><CardHeader><CardTitle>Connected accounts & tokens</CardTitle><CardDescription>Google refresh tokens are encrypted (AES-256-GCM) with a key that only exists as a Cloudflare secret. Manage or revoke them in the Gmail tab, or at myaccount.google.com/permissions.</CardDescription></CardHeader></Card>
          <Card><CardHeader><CardTitle>Your data</CardTitle></CardHeader><CardContent className="space-y-3">
            <Button variant="outline" onClick={async () => { try { downloadBlob(await (await api.exportData()).blob(), 'mailblaster-export.json'); } catch (e) { toast.error(errMsg(e)); } }}><Download className="h-4 w-4" /> Export all my data (JSON)</Button>
            <div className="rounded-lg border border-rose-400/30 p-4"><p className="mb-2 text-sm font-medium text-rose-300">Delete account</p><p className="mb-3 text-xs text-muted-foreground">Permanently deletes your campaigns, contacts, templates, tokens and login, and revokes Google access. This cannot be undone.</p>
              <div className="flex flex-wrap gap-2"><Input className="w-56" placeholder='Type DELETE to confirm' value={del} onChange={(e) => setDel(e.target.value)} aria-label="Type DELETE" /><Button variant="destructive" disabled={del !== 'DELETE'} onClick={async () => { try { await api.deleteAccount(); await signOut(); } catch (e) { toast.error(errMsg(e)); } }}><Trash2 className="h-4 w-4" /> Delete everything</Button></div></div>
          </CardContent></Card>
        </TabsContent>
      </Tabs>
    </>
  );
}
