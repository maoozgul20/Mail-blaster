import * as React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Paperclip, Rocket, Save, X } from 'lucide-react';
import { GMAIL_COMPOSE_SCOPE, localInputToUtc, estimateDuration, findUnresolvedVariables, availableVariables, type Attachment, type CampaignSettings, type FollowUpStepInput, type RecipientInput, type SchedulePresetId } from '@mailblaster/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Dialog, DialogContent, Field, Input, PageHeader, Select, Skeleton, Switch, Textarea } from '@/components/ui';
import { errMsg, useToast } from '@/components/toast';
import { RichEditor } from '@/components/composer/RichEditor';
import { EmailPreview } from '@/components/composer/EmailPreview';
import { RecipientImport } from '@/components/composer/RecipientImport';
import { DEFAULT_STEPS, FollowUpEditor } from '@/components/composer/FollowUpEditor';
import { SchedulePanel, resolveStart, type ScheduleState } from '@/components/composer/SchedulePanel';
import { AiAssistant } from '@/components/composer/AiAssistant';
import { browserTz, fmtDate, humanSeconds, utcToLocalInputSafe } from '@/lib/utils';

function Step({ n, title, children, aside }: { n: number; title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-3"><span className="gradient-bg grid h-7 w-7 place-items-center rounded-full text-sm font-bold">{n}</span><CardTitle className="text-lg">{title}</CardTitle>{aside && <div className="ml-auto">{aside}</div>}</CardHeader>
      <CardContent className="pt-3">{children}</CardContent>
    </Card>
  );
}

export default function NewCampaign() {
  const { id: routeId } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const s = me!.settings;

  const [id, setId] = React.useState<string | undefined>(routeId);
  const [loaded, setLoaded] = React.useState(!routeId);
  const [name, setName] = React.useState('');
  const [subject, setSubject] = React.useState('');
  const [html, setHtml] = React.useState('<p>Hi {{FirstName|there}},</p><p></p><p>Best regards</p>');
  const [bodyText, setBodyText] = React.useState('');
  const [recipients, setRecipients] = React.useState<RecipientInput[]>([]);
  const [recipientsDirty, setRecipientsDirty] = React.useState(false);
  const [savedCount, setSavedCount] = React.useState(0);
  const [accountId, setAccountId] = React.useState('');
  const [delivery, setDelivery] = React.useState<'send' | 'draft'>('send');
  const [followOn, setFollowOn] = React.useState(true);
  const [steps, setSteps] = React.useState<FollowUpStepInput[]>(() => (s.default_followups?.length ? (s.default_followups as FollowUpStepInput[]) : DEFAULT_STEPS));
  const [attachments, setAttachments] = React.useState<Attachment[]>([]);
  const [templateId, setTemplateId] = React.useState('');
  const [settings, setSettings] = React.useState<CampaignSettings>({
    daily_limit: s.daily_limit, min_interval_seconds: s.min_interval_seconds, max_interval_seconds: s.max_interval_seconds, timezone: s.timezone === 'UTC' ? browserTz() : s.timezone,
    business_hours: s.business_hours, weekdays: s.weekdays, track_opens: s.track_opens, track_clicks: s.track_clicks, unsubscribe_link: s.unsubscribe_footer, reply_in_thread: true,
  });
  const [schedule, setSchedule] = React.useState<ScheduleState>({ preset: 'now', custom: '' });
  const [endAt, setEndAt] = React.useState('');
  const [dirty, setDirty] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<Date | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [confirm, setConfirm] = React.useState(false);
  const [launching, setLaunching] = React.useState(false);
  const [error, setError] = React.useState('');
  const touch = <T,>(set: (v: T) => void) => (v: T) => { set(v); setDirty(true); };

  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api.templates() });
  const accounts = me!.accounts.filter((a) => a.status === 'active');
  React.useEffect(() => { if (!accountId && accounts[0]) setAccountId(accounts[0].id); }, [accounts, accountId]);
  const account = accounts.find((a) => a.id === accountId);
  const hasCompose = !!account?.scopes.includes(GMAIL_COMPOSE_SCOPE);

  // load an existing draft
  React.useEffect(() => {
    if (!routeId) return;
    api.getCampaign(routeId).then((c) => {
      if (c.status !== 'draft') { toast.error('Only drafts can be edited'); nav(`/campaigns/${routeId}`, { replace: true }); return; }
      setName(c.name); setSubject(c.subject); setHtml(c.body_html || ''); setBodyText(c.body_text ?? ''); setAccountId(c.account_id ?? ''); setDelivery(c.delivery_mode);
      setSettings((p) => ({ ...p, ...c.settings })); setAttachments(c.attachments ?? []); setFollowOn(c.follow_ups.enabled);
      if (c.follow_ups.steps.length) setSteps(c.follow_ups.steps.map((x: any) => ({ enabled: x.enabled, delay_days: x.delay_days, condition: x.condition, subject: x.subject, body_html: x.body_html, reply_in_thread: x.reply_in_thread })));
      setSavedCount(c.stats.total); setTemplateId(c.template_id ?? '');
      if (c.end_at) setEndAt(utcToLocalInputSafe(c.end_at, c.settings?.timezone ?? 'UTC'));
      setLoaded(true);
    }).catch((e) => { toast.error(errMsg(e)); nav('/campaigns', { replace: true }); });
  }, [routeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const payload = (includeRecipients: boolean) => ({
    name: name.trim() || 'Untitled campaign', subject, body_html: html, body_text: bodyText.trim() ? bodyText : null, account_id: accountId || null, template_id: templateId || null, delivery_mode: delivery,
    settings, attachments, follow_ups: { enabled: followOn, steps },
    end_at: endAt ? localInputToUtc(endAt, settings.timezone)?.toISOString() ?? null : null,
    ...(includeRecipients ? { recipients } : {}),
  });

  const save = React.useCallback(async (silent = true): Promise<string | undefined> => {
    setSaving(true); setError('');
    try {
      let cid = id;
      if (!cid) {
        const r = await api.createCampaign(payload(true) as any);
        cid = r.id; setId(cid); nav(`/campaigns/${cid}/edit`, { replace: true });
      } else await api.updateCampaign(cid, payload(recipientsDirty) as any);
      if (recipientsDirty || !id) { setSavedCount(recipients.length); setRecipientsDirty(false); }
      setDirty(false); setSavedAt(new Date()); qc.invalidateQueries({ queryKey: ['campaigns'] });
      if (!silent) toast.success('Draft saved');
      return cid;
    } catch (e) { setError(errMsg(e)); if (!silent) toast.error(errMsg(e)); return undefined; } finally { setSaving(false); }
  }, [id, name, subject, html, accountId, templateId, delivery, settings, attachments, followOn, steps, endAt, recipients, recipientsDirty]); // eslint-disable-line react-hooks/exhaustive-deps

  // auto-save drafts
  const saveRef = React.useRef(save); saveRef.current = save;
  React.useEffect(() => {
    if (!dirty || !loaded || !name.trim()) return;
    const t = setTimeout(() => saveRef.current(true), 3000);
    return () => clearTimeout(t);
  }, [dirty, loaded, name, subject, html, bodyText, recipients, steps, settings, attachments, followOn, endAt, delivery, accountId]);

  const variables = React.useMemo(() => availableVariables(recipients), [recipients]);
  const unresolved = React.useMemo(() => findUnresolvedVariables(`${subject} ${html}`, recipients), [subject, html, recipients]);
  const eligible = recipientsDirty || !id ? recipients.length : savedCount;
  const startAt = resolveStart(schedule, settings.timezone);
  const est = estimateDuration(eligible, settings.daily_limit, settings.min_interval_seconds, settings.max_interval_seconds);

  const problems: string[] = [];
  if (!account) problems.push('Connect a Gmail account (Settings → Account & Integrations).');
  if (!name.trim()) problems.push('Give the campaign a name.');
  if (!subject.trim()) problems.push('Write a subject line.');
  if (!html.replace(/<[^>]+>/g, '').trim()) problems.push('Write the message.');
  if (eligible === 0) problems.push('Add at least one recipient.');
  if (schedule.preset === 'custom' && !schedule.custom) problems.push('Choose a custom start date and time.');
  if (endAt && (localInputToUtc(endAt, settings.timezone) ?? new Date(0)) <= startAt) problems.push('The end date must be after the start.');

  async function applyTemplate(tid: string) {
    setTemplateId(tid);
    const t = templates.data?.templates.find((x) => x.id === tid);
    if (t) { setSubject(t.subject); setHtml(t.body_html); }
    setDirty(true);
  }
  async function saveAsTemplate() {
    const n = prompt('Template name'); if (!n) return;
    try { await api.createTemplate({ name: n, subject, body_html: html, category: 'My templates' }); toast.success('Saved to your template library'); qc.invalidateQueries({ queryKey: ['templates'] }); } catch (e) { toast.error(errMsg(e)); }
  }
  async function upload(files: FileList | null) {
    if (!files) return;
    for (const f of Array.from(files)) {
      try { const r = await api.uploadAttachment(f); setAttachments((a) => [...a, r.attachment]); setDirty(true); } catch (e) { toast.error(errMsg(e)); }
    }
  }
  async function launch() {
    setLaunching(true); setError('');
    try {
      const cid = await save(true);
      if (!cid) return;
      // `save` leaves the freshly created draft with all recipients; start validates everything again server-side
      await api.startCampaign(cid, schedule.preset === 'now' ? null : startAt.toISOString());
      toast.success(schedule.preset === 'now' ? 'Campaign started: emails are being sent one by one' : `Campaign scheduled for ${fmtDate(startAt, { tz: settings.timezone })}`);
      qc.invalidateQueries(); nav(`/campaigns/${cid}`);
    } catch (e) { setError(errMsg(e)); setConfirm(false); } finally { setLaunching(false); }
  }

  if (!loaded) return <div className="space-y-4"><Skeleton className="h-10 w-1/3" /><Skeleton className="h-64" /></div>;

  return (
    <>
      <PageHeader title={routeId ? 'Edit draft' : 'New campaign'} description="Import recipients, write one message, and MailBlaster sends it individually, personalised, at a safe pace - even when your computer is off."
        actions={<>
          <span className="text-xs text-muted-foreground" aria-live="polite">{saving ? 'Saving…' : savedAt ? `Draft saved ${savedAt.toLocaleTimeString()}` : dirty ? 'Unsaved changes' : ''}</span>
          <Button variant="outline" onClick={() => save(false)} loading={saving}><Save className="h-4 w-4" /> Save draft</Button>
        </>} />
      {error && <Alert tone="error" className="mb-4">{error}</Alert>}
      {accounts.length === 0 && <Alert tone="warn" className="mb-4" title="No Gmail account connected">You can build and save the campaign now, but sending needs a connected account. <Link className="underline" to="/settings/account">Connect Gmail</Link></Alert>}

      <div className="space-y-6">
        <Step n={1} title="Recipients" aside={<span className="text-sm text-muted-foreground">{eligible} in list{!recipientsDirty && id && savedCount > 0 ? ' (saved)' : ''}</span>}>
          {!recipientsDirty && id && savedCount > 0 && recipients.length === 0 && <Alert tone="info" className="mb-3">This draft already has {savedCount} saved recipients. Importing a new list below replaces them.</Alert>}
          <RecipientImport value={recipients} onChange={(r) => { setRecipients(r); setRecipientsDirty(true); setDirty(true); }} />
        </Step>

        <Step n={2} title="Message">
          <div className="grid gap-6 xl:grid-cols-2">
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Campaign name" hint="Only you see this"><Input value={name} onChange={(e) => touch(setName)(e.target.value)} placeholder="e.g. Guest post outreach - November" /></Field>
                <Field label="Template"><Select value={templateId} onChange={(e) => applyTemplate(e.target.value)}><option value="">Start from scratch</option>{templates.data?.templates.map((t) => <option key={t.id} value={t.id}>{t.category} · {t.name}</option>)}</Select></Field>
              </div>
              {accounts.length > 1 && <Field label="Send from"><Select value={accountId} onChange={(e) => touch(setAccountId)(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}</Select></Field>}
              <Field label="Subject"><Input value={subject} onChange={(e) => touch(setSubject)(e.target.value)} placeholder="Quick idea for {{Company}}" /></Field>
              <RichEditor value={html} onChange={touch(setHtml)} variables={variables} />
              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-white/5"><Paperclip className="h-4 w-4" /> Attach file<input type="file" multiple className="sr-only" onChange={(e) => { upload(e.target.files); e.target.value = ''; }} disabled={attachments.length >= 3} /></label>
                {attachments.map((a) => <span key={a.path} className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2.5 py-1 text-xs">{a.name} · {(a.size / 1024).toFixed(0)} KB<button aria-label={`Remove ${a.name}`} onClick={() => { api.deleteAttachment(a.path).catch(() => undefined); setAttachments((x) => x.filter((y) => y.path !== a.path)); setDirty(true); }}><X className="h-3 w-3" /></button></span>)}
                <span className="text-xs text-muted-foreground">Max 3 files, 2 MB total (PDF, images, Office, TXT, CSV).</span>
                <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={saveAsTemplate}>Save as template</Button>
              </div>
              <details className="rounded-md border border-border/60 px-3 py-2 text-sm">
                <summary className="cursor-pointer text-muted-foreground">Plain-text version (optional)</summary>
                <Textarea className="mt-2 font-mono text-xs" rows={5} value={bodyText} onChange={(e) => touch(setBodyText)(e.target.value)} placeholder="Leave empty to generate it automatically from the HTML" aria-label="Plain-text alternative" />
                <p className="mt-1 text-xs text-muted-foreground">Sent as the text/plain part of every email. Merge tags work here too.</p>
              </details>
              {me?.settings.signature_html ? <p className="text-xs text-muted-foreground">Your saved signature is appended automatically.</p> : <p className="text-xs text-muted-foreground">Tip: add a signature in Settings and it is appended to every email.</p>}
              {unresolved.length > 0 && recipients.length > 0 && <Alert tone="warn">No recipient has a value for {unresolved.map((u) => `{{${u}}}`).join(', ')}. Add a fallback like {'{{FirstName|there}}'} or map that column.</Alert>}
              <AiAssistant subject={subject} html={html} onApply={(r) => { if (r.subject !== undefined) touch(setSubject)(r.subject); if (r.html !== undefined) touch(setHtml)(r.html); }} />
            </div>
            <div><h4 className="mb-2 text-sm font-semibold">Preview</h4>
              <EmailPreview subject={subject} html={html} recipients={recipients} signature={me?.settings.signature_html}
                stages={followOn ? steps.map((st, i) => ({ label: `Follow-up ${i + 1}`, subject: st.subject, html: st.body_html })) : []} />
            </div>
          </div>
        </Step>

        <Step n={3} title="Follow-ups" aside={<label className="flex items-center gap-2 text-sm">Enabled <Switch checked={followOn} onCheckedChange={touch(setFollowOn)} aria-label="Enable follow-ups" /></label>}>
          {followOn ? <FollowUpEditor steps={steps} onChange={touch(setSteps)} variables={variables} /> : <p className="text-sm text-muted-foreground">No follow-ups will be sent.</p>}
        </Step>

        <Step n={4} title="Delivery & schedule">
          <SchedulePanel settings={settings} onSettings={(p) => { setSettings((x) => ({ ...x, ...p })); setDirty(true); }} schedule={schedule} onSchedule={setSchedule} endAt={endAt} onEndAt={touch(setEndAt)}
            recipients={eligible} delivery={delivery} onDelivery={touch(setDelivery)} hasCompose={hasCompose} />
        </Step>

        <Step n={5} title="Review & launch">
          {problems.length > 0 ? <Alert tone="warn" title="Before you can launch"><ul className="list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul></Alert> : (
            <div className="space-y-1 text-sm">
              <p><b>{eligible}</b> individual emails from <b>{account?.email}</b>, starting <b>{schedule.preset === 'now' ? 'now' : fmtDate(startAt, { tz: settings.timezone })}</b></p>
              <p className="text-muted-foreground">One at a time, {humanSeconds(settings.min_interval_seconds)}–{humanSeconds(settings.max_interval_seconds)} apart, max {settings.daily_limit}/day → about {est.days === 1 ? `${est.hours} hours` : `${est.days} days`}. {followOn ? `${steps.filter((x) => x.enabled).length} follow-up stage(s).` : 'No follow-ups.'}</p>
            </div>)}
          <div className="mt-4 flex flex-wrap gap-3">
            <Button size="lg" disabled={problems.length > 0} onClick={() => setConfirm(true)}><Rocket className="h-4 w-4" /> {schedule.preset === 'now' ? 'Send campaign' : 'Schedule campaign'}</Button>
            <Button size="lg" variant="outline" onClick={() => save(false)} loading={saving}><Save className="h-4 w-4" /> Save draft</Button>
          </div>
        </Step>
      </div>

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent title="Ready to launch?" description="Please double-check. Emails that have been sent cannot be recalled.">
          <ul className="space-y-1.5 text-sm">
            <li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-400" /> {eligible} recipients, each emailed individually (never grouped in To/BCC)</li>
            <li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-400" /> Sent from {account?.email} via the Gmail API</li>
            <li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-400" /> {schedule.preset === 'now' ? 'First email goes out immediately' : `First email: ${fmtDate(startAt, { tz: settings.timezone })}`}</li>
            <li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-400" /> Runs in the cloud: you can close this tab and switch off your computer</li>
            {delivery === 'draft' && <li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-400" /> Creates Gmail drafts only: nothing is sent automatically</li>}
          </ul>
          <div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => setConfirm(false)}>Back</Button><Button loading={launching} onClick={launch}><Rocket className="h-4 w-4" /> {schedule.preset === 'now' ? 'Start sending' : 'Schedule'}</Button></div>
        </DialogContent>
      </Dialog>
    </>
  );
}
