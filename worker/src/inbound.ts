import { GMAIL_READ_SCOPE } from '@mailblaster/shared';
import { parseFromAddress, type GmailApi, type GmailMessageMeta } from './gmail';
import type { Store } from './store';

export interface InboundDeps {
  store: Store;
  gmail: GmailApi;
  getToken: (accountId: string) => Promise<string>;
  clock?: () => Date;
  maxMessages?: number;
}

export type InboundKind = 'reply' | 'bounce_permanent' | 'bounce_temporary' | 'auto' | 'ignore';

/** Classify an inbound message that arrived in one of OUR threads. Never guesses beyond what the headers prove. */
export function classifyInbound(m: Pick<GmailMessageMeta, 'from' | 'subject' | 'autoSubmitted' | 'snippet'>): InboundKind {
  const from = parseFromAddress(m.from);
  const isDaemon = /^(mailer-daemon|postmaster)@/.test(from) || /mailer-daemon/i.test(m.from);
  if (isDaemon) {
    if (/delay|delayed|warning/i.test(m.subject) && !/failure|undeliver|not delivered/i.test(m.subject)) return 'bounce_temporary';
    if (/failure|undeliver|not delivered|returned mail|could not be delivered|delivery status notification/i.test(`${m.subject} ${m.snippet}`)) return 'bounce_permanent';
    return 'bounce_temporary';
  }
  if (m.autoSubmitted && m.autoSubmitted.toLowerCase() !== 'no') return 'auto'; // out-of-office etc.: not a human reply
  return 'reply';
}

export interface InboundSummary { accounts: number; messages: number; replies: number; bounces: number; errors: string[] }

/** Poll Gmail (optional read scope) for replies/bounces on threads we started. Idempotent: every message id is stored once. */
export async function runInbound(d: InboundDeps): Promise<InboundSummary> {
  const now = d.clock ? d.clock() : new Date();
  const out: InboundSummary = { accounts: 0, messages: 0, replies: 0, bounces: 0, errors: [] };
  const accounts = await d.store.rpc<{ id: string; email: string; last_check: string | null; scopes: string[] }[]>(
    'wk_accounts_for_reply_check', { p_min_age_seconds: 240, p_limit: 3, ...(d.clock ? { p_now: now.toISOString() } : {}) });
  for (const a of accounts ?? []) {
    if (!a.scopes.includes(GMAIL_READ_SCOPE)) continue;
    out.accounts++;
    try {
      const token = await d.getToken(a.id);
      const since = a.last_check ? new Date(a.last_check).getTime() - 120_000 : now.getTime() - 3 * 86400_000;
      const ids = await d.gmail.listMessages(token, `after:${Math.floor(since / 1000)} -from:me -in:sent -in:drafts`, d.maxMessages ?? 15);
      if (ids.length) {
        const known = new Set(await d.store.rpc<string[]>('wk_thread_ids_for_account', { p_account: a.id }));
        for (const id of ids) {
          const m = await d.gmail.getMessage(token, id);
          if (!known.has(m.threadId)) continue; // not one of our campaign threads
          out.messages++;
          const kind = classifyInbound(m);
          const stamp = d.clock ? { p_now: now.toISOString() } : {};
          if (kind === 'reply') {
            const r = await d.store.rpc<string>('wk_record_reply', {
              p_account: a.id, p_thread: m.threadId, p_msg: m.id, p_from: parseFromAddress(m.from), p_snippet: m.snippet,
              p_received: new Date(m.internalDate || now.getTime()).toISOString(), ...stamp,
            });
            if (r === 'recorded') out.replies++;
          } else if (kind === 'bounce_permanent' || kind === 'bounce_temporary') {
            const r = await d.store.rpc<string>('wk_record_bounce', {
              p_account: a.id, p_thread: m.threadId, p_msg: m.id, p_type: kind === 'bounce_permanent' ? 'permanent' : 'temporary',
              p_reason: `${m.subject} — ${m.snippet}`.slice(0, 400), ...stamp,
            });
            if (r === 'recorded') out.bounces++;
          }
        }
      }
      await d.store.rpc('wk_set_reply_checked', { p_account: a.id, p_at: now.toISOString() });
    } catch (e) {
      out.errors.push(`${a.email}: ${(e as Error).message}`);
    }
  }
  return out;
}
