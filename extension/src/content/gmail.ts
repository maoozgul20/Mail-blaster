import { parsePastedList, type RecipientInput } from '@mailblaster/shared';

/** All Gmail-specific DOM knowledge lives here. Gmail changes its markup occasionally: every lookup has a fallback. */
export interface Compose {
  root: HTMLElement;
  subjectEl: HTMLInputElement;
  bodyEl: () => HTMLElement | null;
  sendButton: () => HTMLElement | null;
}

const BODY_SELECTORS = ['div[role="textbox"][g_editable="true"]', 'div[aria-label="Message Body"]', 'div[role="textbox"][contenteditable="true"]'];
const SEND_SELECTORS = ['div[role="button"][data-tooltip^="Send"]', 'div[role="button"][aria-label^="Send"]', '.T-I.J-J5-Ji.aoO'];

const q = <T extends HTMLElement>(root: ParentNode, sels: string[]) => { for (const s of sels) { const e = root.querySelector<T>(s); if (e) return e; } return null; };

/** A "new message" compose has a visible subject box (replies / inline compose do not, so we leave those alone). */
export function findComposes(doc: Document = document): Compose[] {
  const out: Compose[] = [];
  doc.querySelectorAll<HTMLInputElement>('input[name="subjectbox"]').forEach((subjectEl) => {
    if (subjectEl.type === 'hidden') return;
    const root = (subjectEl.closest('div[role="dialog"]') as HTMLElement | null) ?? (subjectEl.closest('form')?.parentElement?.parentElement as HTMLElement | null);
    if (!root) return;
    out.push({ root, subjectEl, bodyEl: () => q<HTMLElement>(root, BODY_SELECTORS), sendButton: () => q<HTMLElement>(root, SEND_SELECTORS) });
  });
  return out;
}

export const readSubject = (c: Compose) => c.subjectEl.value ?? '';
export function readBodyHtml(c: Compose): string {
  const el = c.bodyEl();
  if (!el) return '';
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.gmail_quote, .gmail_signature_prefix, script, style').forEach((n) => n.remove()); // quoted text is not part of the campaign
  return clone.innerHTML.trim();
}
export const bodyIsEmpty = (html: string) => !html.replace(/<[^>]+>|&nbsp;|\s/g, '');

/** Recipients typed in the To field: each address becomes its own recipient (never one shared message). */
export function readToRecipients(c: Compose): RecipientInput[] {
  const found = new Set<string>();
  c.root.querySelectorAll<HTMLElement>('[name="to"] [email], span[email][data-hovercard-id]').forEach((e) => found.add((e.getAttribute('email') ?? '').toLowerCase()));
  c.root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[name="to"], textarea[name="to"]').forEach((e) => parsePastedList(e.value ?? '').forEach((r) => found.add(r.email)));
  c.root.querySelectorAll<HTMLElement>('[data-hovercard-id]').forEach((e) => { const id = e.getAttribute('data-hovercard-id') ?? ''; if (id.includes('@') && e.closest('[name="to"]')) found.add(id.toLowerCase()); });
  return [...found].filter(Boolean).map((email) => ({ email }));
}

export function insertAtCursor(c: Compose, text: string) {
  const el = c.bodyEl();
  if (!el) return;
  el.focus();
  document.execCommand('insertText', false, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export function setCompose(c: Compose, subject: string, html: string) {
  c.subjectEl.value = subject;
  c.subjectEl.dispatchEvent(new Event('input', { bubbles: true }));
  const el = c.bodyEl();
  if (el) { el.innerHTML = html; el.dispatchEvent(new Event('input', { bubbles: true })); }
}

/** After launching, close the compose so nobody can press Gmail's own Send and mail everybody at once. */
export function discardCompose(c: Compose) {
  const btn = c.root.querySelector<HTMLElement>('[role="button"][data-tooltip^="Discard"], [role="button"][aria-label^="Discard"]');
  btn?.click();
}
