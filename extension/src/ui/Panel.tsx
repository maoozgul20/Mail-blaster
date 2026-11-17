import * as React from 'react';
import Papa from 'papaparse';
import readXlsxFile, { readSheetNames } from 'read-excel-file';
import {
  DELAY_PRESETS, SCHEDULE_PRESETS, WEEKDAYS, FIELD_LABELS, analyzeRecipients, availableVariables, buildMergeData, escapeHtml, estimateDuration, guessMapping, htmlToText,
  localInputToUtc, parsePastedList, renderTemplate, resolveSchedulePreset, rowsToRecipients, sanitizeEmailHtml, utcToLocalInput, GMAIL_COMPOSE_SCOPE,
  type FieldKey, type FollowUpStepInput, type RecipientInput, type SchedulePresetId,
} from '@mailblaster/shared';
import { bg, call, getConfig } from '../chrome-api';
import { bodyIsEmpty, discardCompose, insertAtCursor, readBodyHtml, readSubject, readToRecipients, setCompose, type Compose } from '../content/gmail';
import { LoginForm } from './LoginForm';

type Me = { user: { email: string }; settings: any; accounts: { id: string; email: string; status: string; scopes: string[] }[]; google_configured: boolean };
const PREFS_KEY = 'prefs';
const toHtml = (text: string) => text.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');

function Section({ title, chip, children, open }: { title: string; chip?: string; children: React.ReactNode; open?: boolean }) {
  return <details className="sec" open={open}><summary>{title}{chip && <span className="chip">{chip}</span>}</summary><div className="in">{children}</div></details>;
}

export function Panel({ compose, onClose }: { compose: Compose; onClose: () => void }) {
  const [me, setMe] = React.useState<Me | null>(null);
  const [state, setState] = React.useState<'loading' | 'signedout' | 'ready' | 'error'>('loading');
  const [err, setErr] = React.useState('');
  const [msg, setMsg] = React.useState<{ k: 'e' | 's' | 'i'; t: React.ReactNode } | null>(null);
  const [busy, setBusy] = React.useState('');
  const [imported, setImported] = React.useState<RecipientInput[] | null>(null);
  const [toList, setToList] = React.useState<RecipientInput[]>([]);
  const [raw, setRaw] = React.useState<{ headers: string[]; rows: Record<string, unknown>[]; source: string } | null>(null);
  const [mapping, setMapping] = React.useState<Record<string, FieldKey>>({});
  const [paste, setPaste] = React.useState('');
  const [sheetUrl, setSheetUrl] = React.useState('');
  const [sheetInfo, setSheetInfo] = React.useState<{ spreadsheetId: string; title: string; sheets: { title: string }[] } | null>(null);
  const [subject, setSubject] = React.useState(readSubject(compose));
  const [bodyHtml, setBodyHtml] = React.useState(readBodyHtml(compose));
  const [prefIdx, setPrefIdx] = React.useState(0);
  const [stage, setStage] = React.useState(0);
  const [steps, setSteps] = React.useState<FollowUpStepInput[]>([]);
  const [followOn, setFollowOn] = React.useState(true);
  const [delivery, setDelivery] = React.useState<'send' | 'draft'>('send');
  const [preset, setPreset] = React.useState<SchedulePresetId>('now');
  const [custom, setCustom] = React.useState('');
  const [when, setWhen] = React.useState<'now' | 'later'>('now');
  const [s, setS] = React.useState({ daily_limit: 30, min_interval_seconds: 600, max_interval_seconds: 1200, timezone: 'UTC', track_opens: true, track_clicks: true, unsubscribe_link: true, weekdays: [1, 2, 3, 4, 5, 6, 7], business_hours: { enabled: false, start: '09:00', end: '17:00' } });
  const [unit, setUnit] = React.useState<'seconds' | 'minutes'>('minutes');
  const [templates, setTemplates] = React.useState<any[] | null>(null);
  const [launched, setLaunched] = React.useState<string | null>(null);

  const refreshCompose = React.useCallback(() => { setSubject(readSubject(compose)); setBodyHtml(readBodyHtml(compose)); setToList(readToRecipients(compose)); }, [compose]);

  const load = React.useCallback(async () => {
    setState('loading');
    try {
      const st = await bg<{ signedIn: boolean }>({ type: 'status' });
      if (!st.signedIn) { setState('signedout'); return; }
      const m = (await call('me')) as Me;
      const prefs = ((await chrome.storage.sync.get(PREFS_KEY))[PREFS_KEY] ?? {}) as Partial<typeof s> & { steps?: FollowUpStepInput[]; unit?: 'seconds' | 'minutes' };
      setMe(m);
      const d = m.settings;
      setS({ daily_limit: d.daily_limit, min_interval_seconds: d.min_interval_seconds, max_interval_seconds: d.max_interval_seconds, timezone: d.timezone === 'UTC' ? Intl.DateTimeFormat().resolvedOptions().timeZone : d.timezone,
        track_opens: d.track_opens, track_clicks: d.track_clicks, unsubscribe_link: d.unsubscribe_footer, weekdays: d.weekdays, business_hours: d.business_hours, ...prefs });
      setUnit(prefs.unit ?? 'minutes');
      setSteps(prefs.steps ?? d.default_followups ?? []);
      refreshCompose();
      setState('ready');
    } catch (e) { setErr((e as Error).message); setState('error'); }
  }, [refreshCompose]);
  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => { if (state === 'ready') chrome.storage.sync.set({ [PREFS_KEY]: { ...s, steps, unit } }).catch(() => undefined); }, [s, steps, unit, state]);

  const recipients = imported ?? toList;
  const analysis = React.useMemo(() => analyzeRecipients(recipients), [recipients]);
  const account = me?.accounts.find((a) => a.status === 'active');
  const hasCompose = !!account?.scopes.includes(GMAIL_COMPOSE_SCOPE);
  const mul = unit === 'minutes' ? 60 : 1;
  const mm = (n: number) => Math.round((n / mul) * 100) / 100;
  const startAt = (): Date => (when === 'now' ? new Date() : preset === 'custom' ? localInputToUtc(custom, s.timezone) ?? new Date() : resolveSchedulePreset(preset, new Date(), s.timezone));
  const est = estimateDuration(analysis.valid.length, s.daily_limit, s.min_interval_seconds, s.max_interval_seconds);

  function load_(r: { headers: string[]; rows: Record<string, unknown>[]; source: string }) {
    const m = guessMapping(r.headers); setRaw(r); setMapping(m); setImported(rowsToRecipients(r.rows, m));
    if (!Object.values(m).includes('email')) setMsg({ k: 'e', t: 'No email column found: choose it below.' });
  }
  const table = (data: unknown[][], source: string) => {
    const [head = [], ...rest] = data; const seen = new Map<string, number>();
    const headers = head.map((h, i) => { let n = String(h ?? '').trim() || `Column ${i + 1}`; const c = (seen.get(n) ?? 0) + 1; seen.set(n, c); if (c > 1) n = `${n} (${c})`; return n; });
    load_({ headers, source, rows: rest.filter((r) => r.some((c) => String(c ?? '').trim())).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']))) });
  };
  async function onFile(f: File) {
    try {
      const ext = f.name.split('.').pop()?.toLowerCase();
      if (ext === 'xlsx') { const names = await readSheetNames(f); table((await readXlsxFile(f, { sheet: names[0] })) as unknown[][], `${f.name} › ${names[0]}`); }
      else if (ext === 'csv' || ext === 'tsv' || ext === 'txt') table(Papa.parse<string[]>((await f.text()).replace(/^﻿/, ''), { skipEmptyLines: true }).data, f.name);
      else setMsg({ k: 'e', t: 'Choose a .csv or .xlsx file.' });
    } catch (e) { setMsg({ k: 'e', t: `Could not read the file: ${(e as Error).message}` }); }
  }

  const payload = (launch: boolean) => ({
    name: `${(subject || 'Gmail campaign').slice(0, 70)} · ${new Date().toLocaleDateString()}`, subject, body_html: sanitizeEmailHtml(bodyHtml), account_id: account?.id ?? null, delivery_mode: delivery,
    settings: { ...s }, follow_ups: { enabled: followOn, steps }, recipients: analysis.valid, launch, start_at: launch && when === 'later' ? startAt().toISOString() : null,
  });

  async function send() {
    refreshCompose();
    const sub = readSubject(compose), body = readBodyHtml(compose);
    if (!account) return setMsg({ k: 'e', t: 'Connect a Gmail account first.' });
    if (!sub.trim()) return setMsg({ k: 'e', t: 'Add a subject in the compose window.' });
    if (bodyIsEmpty(body)) return setMsg({ k: 'e', t: 'Write your message in the compose window.' });
    if (!analysis.valid.length) return setMsg({ k: 'e', t: 'Add at least one valid recipient (To field, CSV/Excel, Google Sheet or paste).' });
    setBusy('send'); setMsg(null);
    try {
      const r = await call<{ id: string; launched: boolean; error?: string }>('createCampaign', { ...payload(true), subject: sub, body_html: sanitizeEmailHtml(body) });
      if (!r.launched) { setMsg({ k: 'e', t: `Saved as a draft but not started: ${r.error}` }); return; }
      setLaunched(r.id);
      setMsg({ k: 's', t: `Campaign ${when === 'now' ? 'started' : 'scheduled'}: ${analysis.valid.length} individual emails. You can close Gmail; sending continues in the cloud.` });
      setTimeout(() => discardCompose(compose), 600);
    } catch (e) { setMsg({ k: 'e', t: (e as Error).message }); } finally { setBusy(''); }
  }
  async function openEditor() {
    refreshCompose(); setBusy('editor'); setMsg(null);
    try {
      const r = await call<{ id: string }>('createCampaign', { ...payload(false), subject: readSubject(compose), body_html: sanitizeEmailHtml(readBodyHtml(compose)) });
      await bg({ type: 'openTab', url: `/campaigns/${r.id}/edit` });
    } catch (e) { setMsg({ k: 'e', t: (e as Error).message }); } finally { setBusy(''); }
  }
  async function sendTest() {
    refreshCompose(); setBusy('test'); setMsg(null);
    try {
      const r = await call<{ to: string }>('testEmail', { account_id: account?.id, subject: readSubject(compose), body_html: sanitizeEmailHtml(readBodyHtml(compose)), recipient: analysis.valid[0] });
      setMsg({ k: 's', t: `Test email sent to ${r.to}` });
    } catch (e) { setMsg({ k: 'e', t: (e as Error).message }); } finally { setBusy(''); }
  }
  async function findSheet() {
    setBusy('sheet'); try { setSheetInfo(await call('sheetsInfo', sheetUrl)); } catch (e) { setMsg({ k: 'e', t: (e as Error).message }); } finally { setBusy(''); }
  }
  async function loadSheet(t: string) {
    if (!sheetInfo) return; setBusy('sheet');
    try { const v = await call<{ headers: string[]; rows: Record<string, string>[] }>('sheetsValues', sheetInfo.spreadsheetId, t); load_({ headers: v.headers, rows: v.rows, source: `${sheetInfo.title} › ${t}` }); }
    catch (e) { setMsg({ k: 'e', t: (e as Error).message }); } finally { setBusy(''); }
  }

  const sample = analysis.valid[Math.min(prefIdx, analysis.valid.length - 1)] ?? { email: 'jane@example.com', first_name: 'Jane', company: 'Example Co' };
  const data = buildMergeData(sample);
  const pv = stage === 0 ? { subject, html: bodyHtml } : { subject: steps[stage - 1]?.subject || `Re: ${subject}`, html: steps[stage - 1]?.body_html ?? '' };
  const previewDoc = `<body style="margin:10px;font:14px system-ui;color:#111">${renderTemplate(sanitizeEmailHtml(pv.html), data, { html: true }).text}</body>`;
  const variables = availableVariables(recipients);
  const setStep = (i: number, p: Partial<FollowUpStepInput>) => setSteps((x) => x.map((v, j) => (i === j ? { ...v, ...p } : v)));
  const COND: [string, string][] = [['no_reply', 'No Reply'], ['no_open', 'Not Opened'], ['no_click', 'No Click'], ['always', 'Always']];

  return (
    <div className="mb panel" role="dialog" aria-label="MailBlaster campaign">
      <div className="hdr"><span>✉ MailBlaster AI</span><span className="sp" />
        {state === 'ready' && (account ? <span className="pill" title={account.email}>Connected</span> : <span className="pill warn">Gmail not connected</span>)}
        <button className="x" aria-label="Close" onClick={onClose}>×</button></div>

      {state === 'loading' && <div className="body"><p className="muted">Loading…</p></div>}
      {state === 'error' && <div className="body"><div className="msg e">{err}</div><button className="btn" onClick={load}>Retry</button></div>}
      {state === 'signedout' && <LoginForm onDone={load} />}

      {state === 'ready' && me && (<>
        <div className="body">
          {!account && <div className="msg i">Connect your Gmail account first. <a style={{ color: '#a5b4fc', cursor: 'pointer' }} onClick={() => bg({ type: 'openTab', url: '/settings/account' })}>Open Account &amp; Integrations</a></div>}
          {account && <p className="muted">Sending as <b style={{ color: '#e5e7eb' }}>{account.email}</b>. Each recipient gets their own individual email.</p>}

          <Section title="Recipients" chip={`${analysis.valid.length} valid`} open>
            <div className="row"><span className={`badge ${analysis.valid.length ? 'g' : 'a'}`}>{analysis.valid.length} valid</span>
              {analysis.invalid.length > 0 && <span className="badge r">{analysis.invalid.length} invalid</span>}
              {analysis.duplicates.length > 0 && <span className="badge a">{analysis.duplicates.length} duplicates</span>}
              <span className="muted">{imported ? 'from import' : 'from the To field'}</span>
              <span style={{ flex: 1 }} /><button className="btn sm" onClick={() => { refreshCompose(); setImported(null); setRaw(null); }}>Use To field</button></div>
            <div className="row"><label className="btn sm" style={{ margin: 0 }}>Upload CSV / Excel<input data-testid="file" type="file" accept=".csv,.tsv,.txt,.xlsx" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} /></label>
              <button className="btn sm" onClick={() => setImported([{ email: 'ali@example.com', first_name: 'Ali', company: 'Acme Digital' }, { email: 'sara@example.com', first_name: 'Sara', company: 'Beta Media' }])}>Sample rows</button></div>
            <textarea aria-label="Paste email addresses" placeholder="Paste addresses (comma / new line)…" value={paste} onChange={(e) => setPaste(e.target.value)} style={{ minHeight: 44 }} />
            <div className="row"><button className="btn sm" disabled={!paste.trim()} onClick={() => { setImported([...(imported ?? []), ...parsePastedList(paste)]); setPaste(''); }}>Add pasted</button></div>
            <div className="row"><input className="grow" type="url" placeholder="Google Sheets URL" aria-label="Google Sheets URL" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} /><button className="btn sm" disabled={!sheetUrl || busy === 'sheet'} onClick={findSheet}>Find</button></div>
            {sheetInfo && <div className="chips">{sheetInfo.sheets.map((t) => <button key={t.title} className="c" onClick={() => loadSheet(t.title)}>{t.title}</button>)}</div>}
            {raw && <div><label>Map columns ({raw.source})</label>{raw.headers.map((h) => (
              <div className="row" key={h} style={{ marginBottom: 3 }}><span className="muted grow" title={h} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{h}</span>
                <select style={{ width: 150 }} aria-label={`Map ${h}`} value={mapping[h]} onChange={(e) => { const m = { ...mapping }; if (e.target.value === 'email') for (const k of Object.keys(m)) if (m[k] === 'email') m[k] = 'custom'; m[h] = e.target.value as FieldKey; setMapping(m); setImported(rowsToRecipients(raw.rows, m)); }}>
                  {Object.entries(FIELD_LABELS).map(([k, l]) => <option key={k} value={k}>{k === 'custom' ? `{{${h}}}` : l}</option>)}</select></div>))}</div>}
            {(analysis.invalid.length > 0 || analysis.duplicates.length > 0) && <button className="btn sm" onClick={() => setImported(analysis.valid)}>Remove invalid &amp; duplicates</button>}
            {analysis.valid.length > 0 && <table aria-label="Recipient preview"><tbody>{analysis.valid.slice(0, 4).map((r) => <tr key={r.email}><td>{r.email}</td><td className="muted">{[r.first_name, r.company].filter(Boolean).join(' · ')}</td></tr>)}</tbody></table>}
            <p className="muted">Suppressed and unsubscribed addresses are excluded automatically at send time.</p>
          </Section>

          <Section title="Message" chip={subject ? subject.slice(0, 22) : 'empty'}>
            <p className="muted">Write the subject and body in the Gmail compose window. Use merge tags like {'{{FirstName}}'}.</p>
            <div className="chips">{variables.slice(0, 12).map((v) => <button key={v} className="c" onClick={() => insertAtCursor(compose, `{{${v}}}`)}>{`{{${v}}}`}</button>)}<button className="c" onClick={() => insertAtCursor(compose, '{{FirstName|there}}')}>{'{{FirstName|there}}'}</button></div>
            <div className="row"><select className="grow" aria-label="Template" onFocus={async () => { if (!templates) try { setTemplates(((await call('templates')) as any).templates); } catch { setTemplates([]); } }}
              onChange={(e) => { const t = templates?.find((x) => x.id === e.target.value); if (t) { setCompose(compose, t.subject, t.body_html); refreshCompose(); } }}>
              <option value="">Insert a template…</option>{templates?.map((t) => <option key={t.id} value={t.id}>{t.category} · {t.name}</option>)}</select>
              <button className="btn sm" onClick={refreshCompose}>Refresh</button></div>
            <div className="row"><select className="grow" aria-label="Preview stage" value={stage} onChange={(e) => setStage(+e.target.value)}><option value={0}>Initial email</option>{steps.map((_, i) => <option key={i} value={i + 1}>Follow-up {i + 1}</option>)}</select>
              <select className="grow" aria-label="Preview recipient" value={prefIdx} onChange={(e) => setPrefIdx(+e.target.value)}>{analysis.valid.length ? analysis.valid.slice(0, 100).map((r, i) => <option key={r.email} value={i}>{r.email}</option>) : <option>(sample)</option>}</select></div>
            <div className="muted"><b>Subject:</b> {renderTemplate(stage === 0 ? subject : pv.subject, data).text || '(none)'}</div>
            <iframe className="frame" title="Email preview" sandbox="" srcDoc={previewDoc} />
            <div className="row"><button className="btn sm" disabled={busy === 'test' || !account} onClick={sendTest}>{busy === 'test' ? 'Sending…' : 'Send test to myself'}</button></div>
          </Section>

          <Section title="Follow-ups" chip={followOn ? `${steps.filter((x) => x.enabled).length} stage(s)` : 'off'}>
            <label className="row" style={{ margin: 0 }}><input type="checkbox" checked={followOn} onChange={(e) => setFollowOn(e.target.checked)} /> Automatic follow-ups (stop on reply, unsubscribe, bounce)</label>
            {followOn && steps.map((st, i) => (
              <div className="stage" key={i}>
                <div className="row"><b>Stage {i + 1}:</b><input type="checkbox" aria-label={`Enable stage ${i + 1}`} checked={st.enabled} onChange={(e) => setStep(i, { enabled: e.target.checked })} />
                  <span className="muted">If</span><select style={{ width: 104 }} aria-label={`Stage ${i + 1} condition`} value={st.condition} onChange={(e) => setStep(i, { condition: e.target.value as any })}>{COND.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                  <span className="muted">after</span><input style={{ width: 54 }} type="number" min={0.01} step="any" aria-label={`Stage ${i + 1} days`} value={st.delay_days} onChange={(e) => setStep(i, { delay_days: Math.max(0.001, +e.target.value || 1) })} /><span className="muted">days</span>
                  <button className="x" style={{ color: '#fda4af', marginLeft: 'auto' }} aria-label={`Remove stage ${i + 1}`} onClick={() => setSteps(steps.filter((_, j) => j !== i))}>×</button></div>
                {st.enabled && <textarea key={`t${i}-${steps.length}`} aria-label={`Stage ${i + 1} text`} defaultValue={htmlToText(st.body_html)} onChange={(e) => setStep(i, { body_html: toHtml(e.target.value) })} style={{ marginTop: 6 }} />}
              </div>))}
            {followOn && steps.length < 10 && <button className="btn sm" onClick={() => setSteps([...steps, { enabled: true, delay_days: 7, condition: 'no_reply', subject: '', body_html: '<p>Hi {{FirstName|there}},</p>' }])}>+ Add stage</button>}
            <p className="muted">Reply detection needs the optional Gmail read permission (dashboard → Account &amp; Integrations).</p>
          </Section>

          <Section title="Delivery" chip={delivery === 'send' ? 'send' : 'drafts'}>
            <label className="row" style={{ margin: 0 }}><input type="radio" name="mb-del" checked={delivery === 'send'} onChange={() => setDelivery('send')} /> Send emails</label>
            <label className="row" style={{ margin: 0, opacity: hasCompose ? 1 : 0.5 }}><input type="radio" name="mb-del" disabled={!hasCompose} checked={delivery === 'draft'} onChange={() => setDelivery('draft')} /> Create drafts (review, then send yourself)</label>
            {account && <p className="muted">Sending through Gmail as {account.email}.</p>}
          </Section>

          <Section title="Schedule" chip={when === 'now' ? 'now' : preset}>
            <div className="chips">{SCHEDULE_PRESETS.map((p) => <button key={p.id} className={`c ${when === (p.id === 'now' ? 'now' : 'later') && preset === p.id ? 'on' : ''}`} onClick={() => { setPreset(p.id); setWhen(p.id === 'now' ? 'now' : 'later'); }}>{p.label}</button>)}
              <button className={`c ${preset === 'custom' ? 'on' : ''}`} onClick={() => { setPreset('custom'); setWhen('later'); setCustom(custom || utcToLocalInput(new Date(Date.now() + 3600_000), s.timezone)); }}>Custom</button></div>
            <div className="row"><label className="row" style={{ margin: 0 }}><input type="radio" name="mb-when" checked={when === 'now'} onChange={() => { setWhen('now'); setPreset('now'); }} /> Send now</label>
              <label className="row" style={{ margin: 0 }}><input type="radio" name="mb-when" checked={when === 'later'} onChange={() => { setWhen('later'); if (preset === 'now') setPreset('custom'); if (!custom) setCustom(utcToLocalInput(new Date(Date.now() + 3600_000), s.timezone)); }} /> Send later</label></div>
            {when === 'later' && preset === 'custom' && <input type="datetime-local" aria-label="Start date and time" value={custom} onChange={(e) => setCustom(e.target.value)} />}
            <div><label>Speed</label>
              <div className="row"><span className="muted">Send max</span><input style={{ width: 62 }} type="number" min={1} max={2000} aria-label="Emails per day" value={s.daily_limit} onChange={(e) => setS({ ...s, daily_limit: Math.max(1, Math.min(2000, +e.target.value || 1)) })} /><span className="muted">emails/day, pause between emails</span></div>
              <div className="row" style={{ marginTop: 4 }}><input style={{ width: 62 }} type="number" min={0} aria-label="Minimum pause" value={mm(s.min_interval_seconds)} onChange={(e) => setS({ ...s, min_interval_seconds: Math.max(0, +e.target.value || 0) * mul })} /><span className="muted">to</span>
                <input style={{ width: 62 }} type="number" min={0} aria-label="Maximum pause" value={mm(s.max_interval_seconds)} onChange={(e) => setS({ ...s, max_interval_seconds: Math.max(0, +e.target.value || 0) * mul })} />
                <select style={{ width: 96 }} aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value as any)}><option value="seconds">seconds</option><option value="minutes">minutes</option></select></div>
              <div className="chips" style={{ marginTop: 6 }}>{DELAY_PRESETS.map((p) => <button key={p.id} className={`c ${s.min_interval_seconds === p.min && s.max_interval_seconds === p.max ? 'on' : ''}`} onClick={() => { setS({ ...s, min_interval_seconds: p.min, max_interval_seconds: p.max }); setUnit(p.min >= 120 ? 'minutes' : 'seconds'); }}>{p.label}</button>)}</div>
              <p className="muted">≈ {est.perDay}/day → {analysis.valid.length} emails ≈ {est.days === 1 ? `${est.hours} h` : `${est.days} days`}. Gmail's own limits always apply.</p>
              {s.max_interval_seconds < 60 && <p className="warn">Very short gaps can look automated to Gmail; prefer 1–5 min or longer for cold outreach.</p>}</div>
          </Section>

          <Section title="Advanced" chip="defaults">
            <label className="row" style={{ margin: 0 }}><input type="checkbox" checked={s.track_opens} onChange={(e) => setS({ ...s, track_opens: e.target.checked })} /> Track opens (approximate)</label>
            <label className="row" style={{ margin: 0 }}><input type="checkbox" checked={s.track_clicks} onChange={(e) => setS({ ...s, track_clicks: e.target.checked })} /> Track clicks</label>
            <label className="row" style={{ margin: 0 }}><input type="checkbox" checked={s.unsubscribe_link} onChange={(e) => setS({ ...s, unsubscribe_link: e.target.checked })} /> Include unsubscribe link</label>
            <label className="row" style={{ margin: 0 }}><input type="checkbox" checked={s.business_hours.enabled} onChange={(e) => setS({ ...s, business_hours: { ...s.business_hours, enabled: e.target.checked } })} /> Business hours only</label>
            {s.business_hours.enabled && <div className="row"><input style={{ width: 100 }} type="time" aria-label="Start time" value={s.business_hours.start} onChange={(e) => setS({ ...s, business_hours: { ...s.business_hours, start: e.target.value } })} /><span className="muted">to</span><input style={{ width: 100 }} type="time" aria-label="End time" value={s.business_hours.end} onChange={(e) => setS({ ...s, business_hours: { ...s.business_hours, end: e.target.value } })} /></div>}
            <div className="chips">{WEEKDAYS.map((d) => <button key={d.n} className={`c ${s.weekdays.includes(d.n) ? 'on' : ''}`} onClick={() => { const w = s.weekdays.includes(d.n) ? s.weekdays.filter((x) => x !== d.n) : [...s.weekdays, d.n].sort(); if (w.length) setS({ ...s, weekdays: w }); }}>{d.label}</button>)}</div>
            <div><label htmlFor="mb-tz">Time zone</label><input id="mb-tz" type="text" value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })} /></div>
          </Section>

          {msg && <div className={`msg ${msg.k}`} role={msg.k === 'e' ? 'alert' : 'status'}>{msg.t}{launched && msg.k === 's' && <> <a style={{ color: '#a7f3d0', cursor: 'pointer', textDecoration: 'underline' }} onClick={() => bg({ type: 'openTab', url: `/campaigns/${launched}` })}>View campaign</a></>}</div>}
        </div>
        <div className="foot">
          <button className="btn primary" disabled={busy === 'send' || !!launched} onClick={send}>{busy === 'send' ? 'Starting…' : when === 'now' ? 'Send campaign' : 'Schedule campaign'}</button>
          <button className="btn" disabled={busy === 'editor'} onClick={openEditor}>Open in full editor</button>
        </div>
      </>)}
    </div>
  );
}
