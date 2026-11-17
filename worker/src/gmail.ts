/** Thin client for the official Gmail REST API. Everything goes through the `GmailApi` interface so tests can use a mock. */
export interface GmailSent { id: string; threadId: string }

export interface GmailMessageMeta {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  internalDate: number;
  autoSubmitted: string | null;
  jobHeader: string | null;
  labelIds: string[];
}

export interface GmailApi {
  send(token: string, raw: string, threadId?: string | null): Promise<GmailSent>;
  createDraft(token: string, raw: string, threadId?: string | null): Promise<GmailSent>;
  /** Reconciliation: find a message we may have sent, by our X-MergeBlast-Job header. */
  findSent(token: string, q: { jobId: string; to: string; afterEpoch: number }): Promise<GmailSent | null>;
  listMessages(token: string, query: string, max: number): Promise<string[]>;
  getMessage(token: string, id: string): Promise<GmailMessageMeta>;
}

/** An HTTP response WAS received from Gmail (so we know the request was rejected/failed). */
export class GmailError extends Error {
  constructor(public status: number, public reason: string, message: string) {
    super(message);
    this.name = 'GmailError';
  }
}
/** No HTTP response (timeout / connection reset): the outcome is UNKNOWN. */
export class GmailNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GmailNetworkError';
  }
}

const hdr = (headers: { name: string; value: string }[] | undefined, n: string) =>
  headers?.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? null;

export class HttpGmail implements GmailApi {
  constructor(private base = 'https://gmail.googleapis.com', private timeoutMs = 25_000) {}

  private async call<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.base}/gmail/v1/users/me/${path}`, {
        ...init,
        signal: ctl.signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) },
      });
    } catch (e) {
      throw new GmailNetworkError((e as Error).message || 'network error');
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      let reason = String(res.status);
      let message = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        reason = j.error?.errors?.[0]?.reason ?? j.error?.status ?? reason;
        message = j.error?.message ?? message;
      } catch { /* non-JSON error body */ }
      throw new GmailError(res.status, reason, message);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      // 2xx with an unreadable body: the request WAS accepted, but we cannot read the id
      throw new GmailNetworkError('Gmail returned a success status with an unreadable body');
    }
  }

  async send(token: string, raw: string, threadId?: string | null): Promise<GmailSent> {
    return this.call(token, 'messages/send', { method: 'POST', body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }) });
  }

  async createDraft(token: string, raw: string, threadId?: string | null): Promise<GmailSent> {
    const d = await this.call<{ id: string; message: GmailSent }>(token, 'drafts', {
      method: 'POST', body: JSON.stringify({ message: { raw, ...(threadId ? { threadId } : {}) } }),
    });
    return { id: d.message.id, threadId: d.message.threadId };
  }

  async listMessages(token: string, query: string, max: number): Promise<string[]> {
    const r = await this.call<{ messages?: { id: string }[] }>(token, `messages?q=${encodeURIComponent(query)}&maxResults=${max}`);
    return (r.messages ?? []).map((m) => m.id);
  }

  async getMessage(token: string, id: string): Promise<GmailMessageMeta> {
    const r = await this.call<any>(
      token,
      `messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Auto-Submitted&metadataHeaders=X-MergeBlast-Job`,
    );
    const h = r.payload?.headers as { name: string; value: string }[] | undefined;
    return {
      id: r.id, threadId: r.threadId, from: hdr(h, 'From') ?? '', subject: hdr(h, 'Subject') ?? '', snippet: r.snippet ?? '',
      internalDate: Number(r.internalDate ?? 0), autoSubmitted: hdr(h, 'Auto-Submitted'), jobHeader: hdr(h, 'X-MergeBlast-Job'),
      labelIds: r.labelIds ?? [],
    };
  }

  async findSent(token: string, q: { jobId: string; to: string; afterEpoch: number }): Promise<GmailSent | null> {
    const ids = await this.listMessages(token, `in:sent to:${q.to} after:${Math.floor(q.afterEpoch)}`, 10);
    for (const id of ids) {
      const m = await this.getMessage(token, id);
      if (m.jobHeader === q.jobId) return { id: m.id, threadId: m.threadId };
    }
    return null;
  }
}

export const parseFromAddress = (from: string): string => {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
};
