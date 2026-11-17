import * as React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { FollowUpStepInput } from '@mailblaster/shared';
import { Button, Card, Field, Input, Select, Switch } from '../ui';
import { RichEditor } from './RichEditor';

export const DEFAULT_STEPS: FollowUpStepInput[] = [
  { enabled: true, delay_days: 3, condition: 'no_reply', subject: '', body_html: '<p>Hi {{FirstName|there}},</p><p>Just floating this to the top of your inbox in case it got buried.</p>' },
  { enabled: true, delay_days: 4, condition: 'no_reply', subject: '', body_html: '<p>Hi {{FirstName|there}},</p><p>Checking in once more - is this something you would like to explore?</p>' },
  { enabled: true, delay_days: 7, condition: 'no_reply', subject: '', body_html: '<p>Hi {{FirstName|there}},</p><p>I will close the loop on my side unless I hear back. Thanks for your time either way.</p>' },
];

const COND = [['no_reply', 'No reply'], ['no_open', 'Not opened'], ['no_click', 'No click'], ['always', 'Always']];

export function FollowUpEditor({ steps, onChange, variables, compact }: { steps: FollowUpStepInput[]; onChange: (s: FollowUpStepInput[]) => void; variables: string[]; compact?: boolean }) {
  const set = (i: number, patch: Partial<FollowUpStepInput>) => onChange(steps.map((s, j) => (i === j ? { ...s, ...patch } : s)));
  return (
    <div className="space-y-3">
      {steps.map((s, i) => (
        <Card key={i} className={`p-4 ${s.enabled ? '' : 'opacity-60'}`}>
          <div className="flex flex-wrap items-center gap-3">
            <Switch checked={s.enabled} onCheckedChange={(v) => set(i, { enabled: v })} aria-label={`Enable stage ${i + 1}`} />
            <span className="text-sm font-semibold">Stage {i + 1}</span>
            <span className="text-sm text-muted-foreground">If</span>
            <Select className="h-9 w-36" value={s.condition} onChange={(e) => set(i, { condition: e.target.value as any })} aria-label="Condition">{COND.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
            <span className="text-sm text-muted-foreground">after</span>
            <Input className="h-9 w-20" type="number" min={0.01} step="any" value={s.delay_days} onChange={(e) => set(i, { delay_days: Math.max(0.001, Number(e.target.value) || 1) })} aria-label="Delay in days" />
            <span className="text-sm text-muted-foreground">{i === 0 ? 'days' : 'additional days'}</span>
            <Button type="button" variant="ghost" size="icon" className="ml-auto" aria-label={`Remove stage ${i + 1}`} onClick={() => onChange(steps.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4 text-rose-400" /></Button>
          </div>
          {s.enabled && !compact && (
            <div className="mt-3 space-y-3">
              <Field label="Subject" hint='Leave empty to reply in the same thread ("Re: …")'><Input value={s.subject} onChange={(e) => set(i, { subject: e.target.value })} placeholder="Re: original subject" /></Field>
              <RichEditor label={`Follow-up ${i + 1} body`} value={s.body_html} onChange={(h) => set(i, { body_html: h })} variables={variables} minHeight={120} />
            </div>
          )}
        </Card>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={steps.length >= 10} onClick={() => onChange([...steps, { enabled: true, delay_days: 7, condition: 'no_reply', subject: '', body_html: '<p>Hi {{FirstName|there}},</p><p></p>' }])}><Plus className="h-4 w-4" /> Add stage</Button>
        <p className="text-xs text-muted-foreground">Follow-ups stop automatically when the person replies*, unsubscribes, bounces, or the campaign is cancelled. *Reply detection needs the optional Gmail read permission.</p>
      </div>
    </div>
  );
}
