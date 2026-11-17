import * as React from 'react';
import { Monitor, Smartphone } from 'lucide-react';
import { buildMergeData, renderTemplate, sanitizeEmailHtml, type RecipientInput } from '@mailblaster/shared';
import { Button, Select } from '../ui';

interface Props {
  subject: string; html: string; recipients: RecipientInput[]; signature?: string;
  stages?: { label: string; subject: string; html: string }[];
}

/** Renders exactly what the merge engine produces for a chosen recipient, inside a script-less sandboxed iframe. */
export function EmailPreview({ subject, html, recipients, signature, stages = [] }: Props) {
  const [device, setDevice] = React.useState<'desktop' | 'mobile'>('desktop');
  const [idx, setIdx] = React.useState(0);
  const [stage, setStage] = React.useState(0);
  const sample = recipients[Math.min(idx, recipients.length - 1)] ?? { email: 'jane@example.com', first_name: 'Jane', last_name: 'Doe', company: 'Example Co' };
  const data = buildMergeData(sample);
  const s = stage === 0 ? { subject, html } : stages[stage - 1] ?? { subject, html };
  const subj = renderTemplate(s.subject || (stage ? `Re: ${subject}` : ''), data);
  const body = renderTemplate(sanitizeEmailHtml(s.html), data, { html: true });
  const doc = `<!doctype html><meta charset="utf-8"><body style="margin:16px;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#111;background:#fff">${body.text}${signature ? `<br><div>${sanitizeEmailHtml(signature)}</div>` : ''}</body>`;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="h-9 w-36 text-xs" value={stage} onChange={(e) => setStage(+e.target.value)} aria-label="Which email to preview">
          <option value={0}>Initial email</option>{stages.map((st, i) => <option key={i} value={i + 1}>{st.label}</option>)}
        </Select>
        <Select className="h-9 min-w-0 flex-1 text-xs" value={idx} onChange={(e) => setIdx(+e.target.value)} aria-label="Preview as recipient">
          {recipients.length === 0 ? <option>(sample · no recipients yet)</option> : recipients.slice(0, 200).map((r, i) => <option key={i} value={i}>{r.email}</option>)}
        </Select>
        <div className="flex rounded-md border border-border">
          <Button type="button" variant={device === 'desktop' ? 'secondary' : 'ghost'} size="icon" className="h-9 w-9" aria-label="Desktop preview" onClick={() => setDevice('desktop')}><Monitor className="h-4 w-4" /></Button>
          <Button type="button" variant={device === 'mobile' ? 'secondary' : 'ghost'} size="icon" className="h-9 w-9" aria-label="Mobile preview" onClick={() => setDevice('mobile')}><Smartphone className="h-4 w-4" /></Button>
        </div>
      </div>
      <div className="overflow-hidden rounded-md border border-border bg-white text-slate-900">
        <div className="space-y-0.5 border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs"><p><b>To:</b> {sample.email}</p><p><b>Subject:</b> {subj.text || '(no subject)'}</p></div>
        <div className="mx-auto" style={{ width: device === 'mobile' ? 360 : '100%', maxWidth: '100%' }}>
          <iframe title="Email preview" sandbox="" srcDoc={doc} className="block h-[320px] w-full border-0" />
        </div>
      </div>
      {(subj.missing.length > 0 || body.missing.length > 0) && <p className="text-xs text-amber-300">No value (and no fallback) for: {[...new Set([...subj.missing, ...body.missing])].map((m) => `{{${m}}}`).join(', ')} for this recipient.</p>}
    </div>
  );
}
