import type { MimeAttachment } from '@mailblaster/shared';
import { GmailError, GmailNetworkError, type GmailApi } from './gmail';
import { GoogleTransientError } from './google';
import { renderEmail, rfcIdForJob, type RenderEnv } from './render';
import type { Store } from './store';
import { ReauthRequired } from './tokens';
import type { ClaimedJob } from './types';
import { GMAIL_READ_SCOPE } from '@mailblaster/shared';

export interface SchedulerDeps {
  store: Store;
  gmail: GmailApi;
  env: RenderEnv;
  getToken: (accountId: string, force?: boolean) => Promise<string>;
  loadAttachment?: (a: ClaimedJob['campaign']['attachments'][number], userId: string) => Promise<MimeAttachment>;
  /** tests only: simulated clock passed to the database as p_now. Production leaves this undefined (database clock). */
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  workerId?: string;
  log?: (msg: string, extra?: unknown) => void;
}

export interface RunOptions {
  /** hard cap on jobs per invocation (Workers Free allows 50 subrequests per invocation; ~5 are used per job) */
  maxJobs?: number;
  /** wall-clock budget for one invocation */
  budgetMs?: number;
  /** wait at most this long for the next short-delay job to become due (supports 5-10 second presets) */
  maxWaitMs?: number;
}

export interface RunSummary {
  claimed: number; submitted: number; drafted: number; retried: number; failed: number; ambiguous: number; held: number; lost: number;
  reconciled: number; errors: string[];
}

export type Verdict =
  | { kind: 'fail'; cls: 'transient' | 'permanent' | 'invalid_recipient' | 'auth' | 'quota'; message: string; blockSeconds?: number }
  | { kind: 'ambiguous'; message: string };

const QUOTA_REASONS = new Set(['dailyLimitExceeded', 'quotaExceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'sendLimitExceeded']);

/** Decide what a Gmail/transport error means. The key rule: only errors proving Gmail did NOT accept the message are retryable. */
export function classifyError(e: unknown): Verdict {
  if (e instanceof GmailNetworkError) return { kind: 'ambiguous', message: `No response from Gmail (${e.message}); outcome unknown` };
  if (e instanceof ReauthRequired) return { kind: 'fail', cls: 'auth', message: e.message };
  if (e instanceof GoogleTransientError) return { kind: 'fail', cls: 'transient', message: `Google auth endpoint unavailable: ${e.message}` };
  if (e instanceof GmailError) {
    const msg = `Gmail ${e.status} ${e.reason}: ${e.message}`.slice(0, 400);
    if (e.status === 401) return { kind: 'fail', cls: 'auth', message: msg };
    if (e.status === 403) {
      if (QUOTA_REASONS.has(e.reason)) {
        return { kind: 'fail', cls: 'quota', message: msg, blockSeconds: /daily|send/i.test(e.reason) ? 4 * 3600 : 15 * 60 };
      }
      if (/insufficient|scope/i.test(e.reason + e.message)) return { kind: 'fail', cls: 'auth', message: msg };
      return { kind: 'fail', cls: 'permanent', message: msg };
    }
    if (e.status === 429) return { kind: 'fail', cls: 'quota', message: msg, blockSeconds: 15 * 60 };
    if (e.status === 400) return { kind: 'fail', cls: /invalid to|recipient|address|mailbox/i.test(e.message) ? 'invalid_recipient' : 'permanent', message: msg };
    if (e.status === 500) return { kind: 'ambiguous', message: msg }; // a bare 500 may or may not have delivered
    if (e.status >= 502 && e.status <= 504) return { kind: 'fail', cls: 'transient', message: msg }; // gateway/unavailable: request not processed
    if (e.status >= 500) return { kind: 'fail', cls: 'transient', message: msg };
    return { kind: 'fail', cls: 'permanent', message: msg };
  }
  return { kind: 'fail', cls: 'transient', message: `Unexpected error: ${(e as Error)?.message ?? String(e)}`.slice(0, 400) };
}

const nowIso = (d: SchedulerDeps) => (d.clock ? { p_now: d.clock().toISOString() } : {});
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function withRetries<T>(fn: () => Promise<T>, tries = 3, sleep: (ms: number) => Promise<void> = defaultSleep): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await sleep(200 * (i + 1)); }
  }
  throw last;
}

type Outcome = 'submitted' | 'drafted' | 'retried' | 'failed' | 'ambiguous' | 'held' | 'lost';

export async function processJob(d: SchedulerDeps, job: ClaimedJob): Promise<Outcome> {
  const { store } = d;
  const fail = async (v: Extract<Verdict, { kind: 'fail' }>): Promise<Outcome> => {
    const r = await store.rpc<{ final?: boolean }>('wk_job_complete_failed', {
      p_job: job.job.id, p_class: v.cls, p_message: v.message, p_block_seconds: v.blockSeconds ?? 3600, ...nowIso(d),
    });
    if (v.cls === 'auth' || v.cls === 'quota') return 'held';
    return r?.final ? 'failed' : 'retried';
  };

  // 1. render (permanent failure on bad data: retrying cannot help)
  let rendered;
  try {
    const attachments = d.loadAttachment ? await Promise.all((job.campaign.attachments ?? []).map((a) => d.loadAttachment!(a, job.job.user_id))) : [];
    rendered = await renderEmail(job, d.env, { attachments });
  } catch (e) {
    return fail({ kind: 'fail', cls: 'permanent', message: `Could not render email: ${(e as Error).message}` });
  }

  // 2. access token (nothing has been sent yet, so every error here is safe to retry/hold)
  let token: string;
  try {
    token = await d.getToken(job.account.id);
  } catch (e) {
    const v = classifyError(e);
    return v.kind === 'fail' ? fail(v) : fail({ kind: 'fail', cls: 'transient', message: v.message });
  }

  // 3. claimed -> sending (aborts if paused/cancelled/lease lost since the claim)
  const ok = await store.rpc<boolean>('wk_job_mark_sending', { p_job: job.job.id, p_worker: job.job.worker, p_lease_seconds: 120, ...nowIso(d) });
  if (!ok) return 'lost';

  // 4. the actual Gmail call
  const draft = job.campaign.delivery_mode === 'draft';
  const call = (t: string) => (draft ? d.gmail.createDraft(t, rendered.raw, rendered.threadId) : d.gmail.send(t, rendered.raw, rendered.threadId));
  let res: { id: string; threadId: string };
  try {
    try {
      res = await call(token);
    } catch (e) {
      if (e instanceof GmailError && e.status === 401) {
        token = await d.getToken(job.account.id, true); // a 401 proves the message was rejected: refresh once and try again
        res = await call(token);
      } else throw e;
    }
  } catch (e) {
    const v = classifyError(e);
    if (v.kind === 'ambiguous') {
      await store.rpc('wk_job_mark_ambiguous', { p_job: job.job.id, p_message: v.message, ...nowIso(d) });
      return 'ambiguous';
    }
    return fail(v);
  }

  // 5. Gmail confirmed: record it (retry the DB write; if it still fails the lease expiry turns the job ambiguous and reconciliation finds the message)
  await withRetries(
    () => store.rpc('wk_job_complete_sent', {
      p_job: job.job.id, p_kind: draft ? 'draft' : 'sent', p_gmail_message_id: res.id, p_thread_id: res.threadId,
      p_rfc_id: rendered.rfcId, p_subject: rendered.subject, p_to: rendered.to, ...nowIso(d),
    }),
    3, d.sleep,
  );
  return draft ? 'drafted' : 'submitted';
}

/** Resolve jobs left in `ambiguous` by asking Gmail whether the message exists (requires the optional read scope). */
export async function reconcileAmbiguous(d: SchedulerDeps, limit = 3): Promise<number> {
  const list = await d.store.rpc<{ job_id: string; account_id: string; to: string; claimed_at: string; scopes: string[]; subject: string; step_number: number }[]>(
    'wk_list_ambiguous', { p_limit: limit });
  let n = 0;
  const now = (d.clock ? d.clock() : new Date()).getTime();
  for (const a of list ?? []) {
    if (!a.scopes?.includes(GMAIL_READ_SCOPE)) continue; // cannot verify: the user resolves it manually in the dashboard
    const ageMs = now - new Date(a.claimed_at).getTime();
    if (ageMs < 90_000) continue; // give Gmail time to index
    try {
      const token = await d.getToken(a.account_id);
      const found = await d.gmail.findSent(token, { jobId: a.job_id, to: a.to, afterEpoch: new Date(a.claimed_at).getTime() / 1000 - 120 });
      if (found) {
        await d.store.rpc('wk_job_complete_sent', {
          p_job: a.job_id, p_kind: 'sent', p_gmail_message_id: found.id, p_thread_id: found.threadId,
          p_rfc_id: null, p_subject: a.subject, p_to: a.to, ...nowIso(d),
        });
        n++;
      } else if (ageMs > 5 * 60_000) {
        await d.store.rpc('wk_job_requeue_ambiguous', { p_job: a.job_id, ...nowIso(d) });
        n++;
      }
    } catch (e) {
      d.log?.('reconcile failed', (e as Error).message);
    }
  }
  return n;
}

/** One scheduler invocation: reconcile, then claim -> send -> record, pacing short delays inside the time budget. */
export async function runScheduler(d: SchedulerDeps, opts: RunOptions = {}): Promise<RunSummary> {
  const maxJobs = opts.maxJobs ?? 6;
  const budgetMs = opts.budgetMs ?? 25_000;
  const maxWaitMs = opts.maxWaitMs ?? 20_000;
  const sleep = d.sleep ?? defaultSleep;
  const t0 = Date.now();
  const worker = d.workerId ?? `w-${crypto.randomUUID().slice(0, 8)}`;
  const s: RunSummary = { claimed: 0, submitted: 0, drafted: 0, retried: 0, failed: 0, ambiguous: 0, held: 0, lost: 0, reconciled: 0, errors: [] };

  try {
    s.reconciled = await reconcileAmbiguous(d);
  } catch (e) {
    s.errors.push(`reconcile: ${(e as Error).message}`);
  }

  while (s.claimed < maxJobs && Date.now() - t0 < budgetMs) {
    let jobs: ClaimedJob[];
    try {
      jobs = await d.store.rpc<ClaimedJob[]>('wk_claim_jobs', { p_limit: Math.min(5, maxJobs - s.claimed), p_lease_seconds: 120, p_worker: worker, ...nowIso(d) });
    } catch (e) {
      s.errors.push(`claim: ${(e as Error).message}`); // database outage: nothing was claimed, the next cron run simply tries again
      break;
    }
    if (!jobs?.length) {
      // short delays (5-10 s presets) are honoured inside one invocation by waiting for the next due job
      try {
        const next = await d.store.rpc<string | null>('wk_peek_next_due', nowIso(d));
        const wait = next ? new Date(next).getTime() - (d.clock ? d.clock().getTime() : Date.now()) : Infinity;
        if (wait <= maxWaitMs && Date.now() - t0 + wait < budgetMs) {
          await sleep(Math.max(wait, 0) + 100);
          continue;
        }
      } catch (e) {
        s.errors.push(`peek: ${(e as Error).message}`);
      }
      break;
    }
    for (const job of jobs) {
      s.claimed++;
      try {
        const out = await processJob(d, job);
        (s as any)[out === 'submitted' ? 'submitted' : out] += 1;
      } catch (e) {
        // e.g. DB write failed after Gmail accepted: do NOT release the job; lease expiry makes it ambiguous and reconciliation resolves it
        s.errors.push(`job ${job.job.id}: ${(e as Error).message}`);
      }
    }
  }
  return s;
}
