import { b64UrlToUtf8 } from '@mailblaster/shared';
import { GmailError, GmailNetworkError, type GmailApi, type GmailMessageMeta, type GmailSent } from '../../src/gmail';

export interface ParsedMail { headers: Record<string, string>; toCount: number; html: string; text: string; raw: string }

export function parseMail(raw: string): ParsedMail {
  const msg = b64UrlToUtf8(raw);
  const [head, ...rest] = msg.split('\r\n\r\n');
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  const body = rest.join('\r\n\r\n');
  const part = (type: string) => {
    const m = body.match(new RegExp(`Content-Type: ${type}; charset="UTF-8"\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+)`));
    return m ? Buffer.from(m[1].replace(/\r\n/g, ''), 'base64').toString('utf8') : '';
  };
  return { headers, toCount: (msg.match(/^To:/gm) ?? []).length, html: part('text/html'), text: part('text/plain'), raw: msg };
}

type Plan = { error?: Error; deliver?: boolean };

/** In-memory stand-in for the Gmail API. Never talks to the network, never sends real email. */
export class MockGmail implements GmailApi {
  sent: (GmailSent & { to: string; mail: ParsedMail; threadIdParam: string | null; token: string })[] = [];
  drafts: (GmailSent & { to: string })[] = [];
  inbox: (GmailMessageMeta & { _at: number })[] = [];
  tokensSeen: string[] = [];
  private plans: Plan[] = [];
  private n = 0;

  /** Next send() call fails with `error`. deliver=true means Gmail actually accepted the message before the failure (lost response). */
  failNext(error: Error, deliver = false) { this.plans.push({ error, deliver }); }
  static http(status: number, reason: string, message = reason) { return new GmailError(status, reason, message); }
  static network(m = 'connection reset') { return new GmailNetworkError(m); }

  private record(raw: string, threadId?: string | null, token = ''): GmailSent & { to: string; mail: ParsedMail; threadIdParam: string | null; token: string } {
    const mail = parseMail(raw);
    const id = `gmsg-${++this.n}`;
    const rec = { id, threadId: threadId || `gthr-${this.n}`, to: mail.headers['to'], mail, threadIdParam: threadId ?? null, token };
    this.sent.push(rec);
    return rec;
  }

  async send(token: string, raw: string, threadId?: string | null): Promise<GmailSent> {
    this.tokensSeen.push(token);
    const plan = this.plans.shift();
    if (plan?.error) {
      if (plan.deliver) this.record(raw, threadId, token);
      throw plan.error;
    }
    const r = this.record(raw, threadId, token);
    return { id: r.id, threadId: r.threadId };
  }

  async createDraft(_token: string, raw: string, threadId?: string | null): Promise<GmailSent> {
    const mail = parseMail(raw);
    const d = { id: `gdraft-${++this.n}`, threadId: threadId || `gthr-${this.n}`, to: mail.headers['to'] };
    this.drafts.push(d);
    return { id: d.id, threadId: d.threadId };
  }

  async findSent(_t: string, q: { jobId: string; to: string }): Promise<GmailSent | null> {
    const hit = this.sent.find((s) => s.mail.headers['x-mergeblast-job'] === q.jobId);
    return hit ? { id: hit.id, threadId: hit.threadId } : null;
  }

  /** simulate an inbound message in one of our threads */
  addInbound(m: Partial<GmailMessageMeta> & { threadId: string; from: string }) {
    this.inbox.push({ id: `in-${++this.n}`, subject: 'Re: hi', snippet: 'Thanks', internalDate: Date.now(), autoSubmitted: null, jobHeader: null, labelIds: ['INBOX'], _at: Date.now(), ...m });
  }
  async listMessages(): Promise<string[]> { return this.inbox.map((m) => m.id); }
  async getMessage(_t: string, id: string): Promise<GmailMessageMeta> {
    const m = this.inbox.find((x) => x.id === id);
    if (!m) throw new GmailError(404, 'notFound', 'nf');
    return m;
  }
}
