import { TestDb } from './pg';

/** Deterministic "future" clock so job.run_after (real now()) is always <= simulated time. Monday 2030-01-07 10:00 UTC. */
export const T0 = new Date('2030-01-07T10:00:00Z');
export const at = (offsetSeconds: number, base = T0) => new Date(base.getTime() + offsetSeconds * 1000).toISOString();

export const rec = (i: number, extra: Record<string, unknown> = {}) => ({
  email: `person${i}@example.com`,
  first_name: `First${i}`,
  last_name: `Last${i}`,
  company: `Co${i}`,
  ...extra,
});

export interface Setup {
  db: TestDb;
  user: string;
  account: string;
  store: ReturnType<TestDb['store']>;
}

export async function setup(scopes?: string[]): Promise<Setup> {
  const db = await TestDb.create();
  const user = await db.createUser();
  const account = await db.createAccount(user, 'sender@gmail.test', scopes);
  return { db, user, account, store: db.store() };
}

export interface CampaignOpts {
  n?: number;
  settings?: Record<string, unknown>;
  followUps?: { enabled?: boolean; steps: Record<string, unknown>[] };
  recipients?: Record<string, unknown>[];
  startAt?: string | null;
  name?: string;
  start?: boolean;
}

export async function makeCampaign(s: Setup, o: CampaignOpts = {}) {
  const recipients = o.recipients ?? Array.from({ length: o.n ?? 3 }, (_, i) => rec(i + 1));
  const saved = await s.db.userRpc(s.user, 'save_campaign', {
    p_id: null,
    p: {
      name: o.name ?? 'Test campaign',
      subject: 'Hello {{FirstName}}',
      body_html: '<p>Hi {{FirstName|there}} from {{Company}}</p>',
      settings: { min_interval_seconds: 600, max_interval_seconds: 1200, daily_limit: 30, ...o.settings },
      follow_ups: o.followUps,
      recipients,
    },
  });
  if (o.start !== false) {
    await s.db.userRpc(s.user, 'start_campaign', { p_id: saved.id, p_start_at: o.startAt ?? null });
  }
  return saved as { id: string; inserted: number; invalid: number; duplicates: number; suppressed: number };
}

export interface ClaimedJob {
  job: { id: string; step_number: number; attempts: number; idempotency_key: string; worker: string };
  account: { id: string; email: string };
  campaign: { id: string; subject: string; body_html: string; settings: Record<string, unknown> };
  recipient: { id: string; email: string; token: string };
  step: { subject: string; body_html: string } | null;
  thread: { thread_id: string; rfc_message_id: string; subject: string } | null;
}

export async function claim(s: Setup, now: string, limit = 10, worker = 'w1', lease = 120): Promise<ClaimedJob[]> {
  return s.store.rpc<ClaimedJob[]>('wk_claim_jobs', { p_limit: limit, p_lease_seconds: lease, p_worker: worker, p_now: now });
}

/** What the Worker does after a confirmed Gmail submission. */
export async function submit(s: Setup, c: ClaimedJob, now: string) {
  const ok = await s.store.rpc<boolean>('wk_job_mark_sending', { p_job: c.job.id, p_worker: c.job.worker, p_lease_seconds: 120, p_now: now });
  if (!ok) throw new Error('mark_sending refused');
  return s.store.rpc<any>('wk_job_complete_sent', {
    p_job: c.job.id, p_kind: 'sent', p_gmail_message_id: `gm-${c.job.id}`, p_thread_id: `th-${c.recipient.id}`,
    p_rfc_id: `<${c.job.id}@mailblaster>`, p_subject: c.campaign.subject, p_to: c.recipient.email, p_now: now,
  });
}

export const count = async (db: TestDb, sql: string, params: unknown[] = []) => Number((await db.q<{ n: number }>(`select count(*)::int n from ${sql}`, params))[0].n);
