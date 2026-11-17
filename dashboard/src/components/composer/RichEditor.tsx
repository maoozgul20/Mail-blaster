import * as React from 'react';
import { Bold, Code2, Eraser, Italic, Link2, List, ListOrdered, Underline, Braces } from 'lucide-react';
import { sanitizeEmailHtml } from '@mailblaster/shared';
import { Button, Select, Textarea } from '../ui';
import { cn } from '@/lib/utils';

interface Props { value: string; onChange: (html: string) => void; variables: string[]; minHeight?: number; placeholder?: string; className?: string; label?: string }

/** Dependency-free rich-text editor (contentEditable) with an HTML source tab and merge-tag inserter. Works without any AI service. */
export function RichEditor({ value, onChange, variables, minHeight = 220, placeholder, className, label = 'Email body' }: Props) {
  const ref = React.useRef<HTMLDivElement>(null);
  const last = React.useRef<string>('');
  const [mode, setMode] = React.useState<'visual' | 'html'>('visual');
  const [varSel, setVarSel] = React.useState('');

  React.useEffect(() => {
    if (mode === 'visual' && ref.current && value !== last.current) {
      ref.current.innerHTML = sanitizeEmailHtml(value ?? '');
      last.current = ref.current.innerHTML;
    }
  }, [value, mode]);

  const emit = () => { if (!ref.current) return; last.current = ref.current.innerHTML; onChange(ref.current.innerHTML); };
  const exec = (cmd: string, arg?: string) => { ref.current?.focus(); document.execCommand(cmd, false, arg); emit(); };
  const addLink = () => {
    const url = prompt('Link URL (https://…)');
    if (!url) return;
    if (!/^(https?:\/\/|mailto:)/i.test(url)) { alert('Links must start with https://, http:// or mailto:'); return; }
    exec('createLink', url);
  };
  const insertVar = (v: string) => {
    if (!v) return;
    const tag = `{{${v}}}`;
    if (mode === 'html') onChange(`${value}${tag}`);
    else { ref.current?.focus(); document.execCommand('insertText', false, tag); emit(); }
    setVarSel('');
  };

  const Tool = ({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) => (
    <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title={label} aria-label={label} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{children}</Button>
  );

  return (
    <div className={cn('overflow-hidden rounded-md border border-input', className)}>
      <div className="flex flex-wrap items-center gap-0.5 border-b border-input bg-muted/60 px-2 py-1">
        {mode === 'visual' && (<>
          <Tool onClick={() => exec('bold')} label="Bold"><Bold className="h-4 w-4" /></Tool>
          <Tool onClick={() => exec('italic')} label="Italic"><Italic className="h-4 w-4" /></Tool>
          <Tool onClick={() => exec('underline')} label="Underline"><Underline className="h-4 w-4" /></Tool>
          <Tool onClick={addLink} label="Insert link"><Link2 className="h-4 w-4" /></Tool>
          <Tool onClick={() => exec('insertUnorderedList')} label="Bulleted list"><List className="h-4 w-4" /></Tool>
          <Tool onClick={() => exec('insertOrderedList')} label="Numbered list"><ListOrdered className="h-4 w-4" /></Tool>
          <Tool onClick={() => exec('removeFormat')} label="Clear formatting"><Eraser className="h-4 w-4" /></Tool>
        </>)}
        <div className="ml-auto flex items-center gap-1">
          <Braces className="h-4 w-4 text-muted-foreground" />
          <Select className="h-8 w-40 py-0 text-xs" value={varSel} onChange={(e) => insertVar(e.target.value)} aria-label="Insert personalization variable">
            <option value="">Insert variable…</option>
            {variables.map((v) => <option key={v} value={v}>{`{{${v}}}`}</option>)}
            <option value="FirstName|there">{'{{FirstName|there}}'} (fallback)</option>
          </Select>
          <Button type="button" variant={mode === 'html' ? 'secondary' : 'ghost'} size="sm" onClick={() => setMode(mode === 'html' ? 'visual' : 'html')}><Code2 className="h-4 w-4" /> HTML</Button>
        </div>
      </div>
      {mode === 'visual' ? (
        <div ref={ref} className="editor-content" style={{ minHeight }} contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label={label}
          data-placeholder={placeholder} onInput={emit} onBlur={emit}
          onPaste={(e) => { e.preventDefault(); const html = e.clipboardData.getData('text/html'); const text = e.clipboardData.getData('text/plain'); document.execCommand(html ? 'insertHTML' : 'insertText', false, html ? sanitizeEmailHtml(html) : text); emit(); }} />
      ) : (
        <Textarea className="rounded-none border-0 font-mono text-xs" style={{ minHeight }} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} aria-label={`${label} (HTML source)`} />
      )}
    </div>
  );
}
