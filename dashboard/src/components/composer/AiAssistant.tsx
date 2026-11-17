import * as React from 'react';
import { Sparkles } from 'lucide-react';
import { htmlToText } from '@mailblaster/shared';
import { Alert, Button, Field, Input, Select, Textarea } from '../ui';
import { errMsg } from '../toast';

/**
 * OPTIONAL writing helper. The composer works fully without it.
 * It talks to any OpenAI-compatible chat endpoint YOU configure (a local Ollama, or a free-tier key such as
 * Google AI Studio / Groq). The key is kept only in this browser's localStorage and is sent straight to that endpoint,
 * never to MailBlaster's servers. No paid AI service is required or assumed.
 */
const KEY = 'mailblaster.ai';
interface Cfg { base: string; model: string; key: string }
const load = (): Cfg => { try { return { base: '', model: '', key: '', ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return { base: '', model: '', key: '' }; } };
const PRESETS: Record<string, Partial<Cfg>> = {
  ollama: { base: 'http://localhost:11434/v1', model: 'llama3.2', key: '' },
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash', key: '' },
  groq: { base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', key: '' },
};

export function AiAssistant({ subject, html, onApply }: { subject: string; html: string; onApply: (r: { subject?: string; html?: string }) => void }) {
  const [open, setOpen] = React.useState(false);
  const [cfg, setCfg] = React.useState<Cfg>(load);
  const [task, setTask] = React.useState('draft');
  const [prompt, setPrompt] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [out, setOut] = React.useState('');
  const [err, setErr] = React.useState('');
  const save = (c: Cfg) => { setCfg(c); try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* ignore */ } };
  const configured = !!cfg.base && !!cfg.model;

  async function run() {
    setBusy(true); setErr(''); setOut('');
    const current = htmlToText(html);
    const instruction = {
      draft: `Write a short, friendly, professional outreach email. Use merge tags like {{FirstName|there}} and {{Company}} where natural. Goal: ${prompt}. Return the email body only as simple HTML (<p>, <ul>, <a>).`,
      improve: `Improve this email's clarity and tone, keep merge tags like {{FirstName}} untouched. ${prompt}\n\n${current}\n\nReturn simple HTML only.`,
      shorten: `Make this email about half as long, keep merge tags untouched.\n\n${current}\n\nReturn simple HTML only.`,
      subjects: `Suggest 5 short, non-spammy subject lines for this email, one per line, no numbering.\n\n${current}`,
    }[task];
    try {
      const res = await fetch(`${cfg.base.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) },
        body: JSON.stringify({ model: cfg.model, messages: [{ role: 'system', content: 'You write concise, honest, non-deceptive business emails.' }, { role: 'user', content: instruction }] }),
      });
      if (!res.ok) throw new Error(`AI endpoint returned ${res.status}`);
      setOut(((await res.json()).choices?.[0]?.message?.content ?? '').replace(/^```(?:html)?\n?|```$/g, '').trim());
    } catch (e) { setErr(`${errMsg(e)}. Check the endpoint, model and (for browsers) that it allows CORS.`); } finally { setBusy(false); }
  }

  return (
    <div className="rounded-lg border border-dashed border-border p-3">
      <button type="button" className="flex w-full items-center gap-2 text-sm font-medium" onClick={() => setOpen((o) => !o)} aria-expanded={open}><Sparkles className="h-4 w-4 text-violet-300" /> AI writing assistant <span className="text-xs font-normal text-muted-foreground">(optional · bring your own free endpoint)</span></button>
      {open && (
        <div className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Provider"><Select value="" onChange={(e) => e.target.value && save({ ...cfg, ...PRESETS[e.target.value] } as Cfg)}><option value="">Preset…</option><option value="ollama">Ollama (local, free)</option><option value="gemini">Google AI Studio (free tier)</option><option value="groq">Groq (free tier)</option></Select></Field>
            <Field label="Base URL" className="sm:col-span-2"><Input value={cfg.base} onChange={(e) => save({ ...cfg, base: e.target.value })} placeholder="https://…/v1" /></Field>
            <Field label="Model"><Input value={cfg.model} onChange={(e) => save({ ...cfg, model: e.target.value })} /></Field>
            <Field label="API key (stored in this browser only)" className="sm:col-span-4"><Input type="password" value={cfg.key} onChange={(e) => save({ ...cfg, key: e.target.value })} autoComplete="off" /></Field>
          </div>
          {!configured && <Alert tone="info">Not configured. Everything else in the editor works without AI.</Alert>}
          <div className="flex flex-wrap gap-2">
            <Select className="w-44" value={task} onChange={(e) => setTask(e.target.value)} aria-label="Task"><option value="draft">Draft an email</option><option value="improve">Improve current text</option><option value="shorten">Shorten</option><option value="subjects">Subject line ideas</option></Select>
            <Input className="min-w-0 flex-1" placeholder="Goal / extra instructions" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            <Button type="button" variant="secondary" loading={busy} disabled={!configured} onClick={run}>Generate</Button>
          </div>
          {err && <Alert tone="error">{err}</Alert>}
          {out && (<div className="space-y-2"><Textarea value={out} onChange={(e) => setOut(e.target.value)} className="font-mono text-xs" />
            <div className="flex gap-2">{task === 'subjects' ? out.split('\n').filter(Boolean).slice(0, 5).map((s) => <Button key={s} type="button" size="sm" variant="outline" onClick={() => onApply({ subject: s.replace(/^[-*\d.\s"]+|"$/g, '') })}>Use “{s.slice(0, 28)}”</Button>) : <Button type="button" size="sm" onClick={() => onApply({ html: out })}>Replace email body</Button>}</div></div>)}
          <p className="text-[11px] text-muted-foreground">Review AI text before sending. Your recipients' data is not sent to the AI, only the text you are editing.</p>
        </div>
      )}
    </div>
  );
}
