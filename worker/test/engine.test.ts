import { describe, it, expect } from 'vitest';
import { setup, makeCampaign, at, rec, count, T0, type Setup } from './helpers/fixtures';
import { MockGmail } from './helpers/mockGmail';
import { runScheduler, processJob, classifyError, type SchedulerDeps } from '../src/scheduler';
import { runInbound, classifyInbound } from '../src/inbound';
import { GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE, GMAIL_COMPOSE_SCOPE, b64UrlToUtf8 } from '@mailblaster/shared';
import type { Store } from '../src/store';

const ENV = { API_BASE_URL: 'https://api.test', ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64') };

function deps(s: Setup, gmail: MockGmail, clock: { t: number }, over: Partial<SchedulerDeps> = {}): SchedulerDeps {
  return {
    store: s.store, gmail, env: ENV, clock: () => new Date(T0.getTime() + clock.t * 1000), sleep: async () => {},
    getToken: async (_a, force) => (force ? 'tok-refreshed' : 'tok-1'), workerId: 'test-worker', ...over,
  };
}
const run = (s: Setup, g: MockGmail, c: { t: number }, over: Partial<SchedulerDeps> = {}, maxJobs = 1) =>
  runScheduler(deps(s, g, c, over), { maxJobs, maxWaitMs: 0 });

async function advanceToNext(s: Setup, c: { t: number }) {
  const [r] = await s.db.q(`select next_send_at n from public.connected_accounts where id=$1`, [s.account]);
  if (r.n) c.t = Math.max(c.t, (new Date(r.n).getTime() - T0.getTime()) / 1000 + 1);
}
const stat = async (s: Setup, id: string) => (await s.db.userRpc(s.user, 'get_campaign', { p_id: id })).stats;

describe('end-to-end sending engine (PostgreSQL + mock Gmail)', () => {
  it('sends 100 recipients as 100 separate emails, one at a time, 10-20 min apart, each personalised', async () => {
    const s = await setup();
    const g = new MockGmail();
    const c = await makeCampaign(s, { n: 100, settings: { daily_limit: 2000, min_interval_seconds: 600, max_interval_seconds: 1200 } });
    const clock = { t: 0 };
    const sendTimes: number[] = [];
    for (let i = 0; i < 100; i++) {
      const before = g.sent.length;
      const sum = await run(s, g, clock);
      expect(sum.errors).toEqual([]);
      expect(g.sent.length - before, `iteration ${i}`).toBe(1); // exactly one email per run
      sendTimes.push(clock.t);
      // asking again immediately sends nothing (the pacing gate is in PostgreSQL)
      expect((await run(s, g, clock)).claimed).toBe(0);
      await advanceToNext(s, clock);
    }
    expect(g.sent).toHaveLength(100);
    expect(new Set(g.sent.map((m) => m.to)).size).toBe(100);
    for (let i = 1; i < sendTimes.length; i++) {
      const gap = sendTimes[i] - sendTimes[i - 1];
      expect(gap).toBeGreaterThanOrEqual(600);
      expect(gap).toBeLessThanOrEqual(1201);
    }
    for (const [i, m] of g.sent.entries()) {
      expect(m.mail.toCount).toBe(1);
      expect(m.mail.raw).not.toMatch(/^(Cc|Bcc):/mi);
      expect(m.mail.headers['subject']).toBe(`Hello First${i + 1}`);
      expect(m.mail.html).toContain(`Hi First${i + 1} from Co${i + 1}`);
      expect(m.mail.html).toMatch(/https:\/\/api\.test\/t\/o\/[a-f0-9]{32}\.gif/);
      expect(m.mail.html).toMatch(/https:\/\/api\.test\/u\/[a-f0-9]{32}/);
      expect(m.mail.headers['list-unsubscribe']).toMatch(/^<https:\/\/api\.test\/u\//);
      expect(m.mail.headers['list-unsubscribe-post']).toBe('List-Unsubscribe=One-Click');
      expect(m.mail.headers['message-id']).toMatch(/^<mb\..+@gmail\.test>$/);
    }
    expect(await stat(s, c.id)).toMatchObject({ total: 100, sent: 100, queued: 0 });
    expect((await s.db.q(`select status from public.campaigns where id=$1`, [c.id]))[0].status).toBe('completed');
    expect(await count(s.db, `public.email_messages where gmail_message_id is not null`)).toBe(100);
  }, 120_000);

  it('fast presets (5-10 s) are paced inside one invocation but never exceed the daily limit', async () => {
    const s = await setup();
    const g = new MockGmail();
    await makeCampaign(s, { n: 8, settings: { daily_limit: 3, min_interval_seconds: 5, max_interval_seconds: 10 } });
    const clock = { t: 0 };
    let slept = 0;
    // simulate time passing during sleeps
    const sleep = async (ms: number) => { slept += ms; clock.t += ms / 1000; };
    const sum = await runScheduler(deps(s, g, clock, { sleep }), { maxJobs: 8, maxWaitMs: 20_000, budgetMs: 60_000 });
    expect(sum.submitted).toBe(3);
    expect(g.sent).toHaveLength(3);
    expect(slept).toBeGreaterThanOrEqual(10_000);
  });

  it('adds attachments to each message', async () => {
    const s = await setup();
    const g = new MockGmail();
    await makeCampaign(s, { n: 1 });
    await s.db.q(`update public.campaigns set attachments='[{"name":"offer.pdf","path":"x/offer.pdf","size":3,"type":"application/pdf"}]'`);
    await run(s, g, { t: 0 }, { loadAttachment: async (a) => ({ filename: a.name, contentType: a.type, data: new Uint8Array([1, 2, 3]) }) });
    expect(g.sent[0].mail.raw).toContain('filename="offer.pdf"');
  });
});

describe('failure handling', () => {
  async function one(over: { scopes?: string[] } = {}) {
    const s = await setup(over.scopes);
    const g = new MockGmail();
    const c = await makeCampaign(s, { n: 1, settings: { min_interval_seconds: 0, max_interval_seconds: 0 } });
    return { s, g, c, clock: { t: 0 } };
  }
  const jobRow = async (s: Setup) => (await s.db.q(`select status, error_class, attempts, last_error from public.sending_jobs`))[0];

  it('401 refreshes the token once and then succeeds', async () => {
    const { s, g, clock } = await one();
    g.failNext(MockGmail.http(401, 'authError', 'expired'));
    await run(s, g, clock);
    expect(g.sent).toHaveLength(1);
    expect(g.tokensSeen).toEqual(['tok-1', 'tok-refreshed']);
    expect((await jobRow(s)).status).toBe('submitted');
  });

  it('403 daily limit pauses the account and keeps the job queued without consuming an attempt', async () => {
    const { s, g, clock } = await one();
    g.failNext(MockGmail.http(403, 'dailyLimitExceeded', 'Daily user sending quota exceeded'));
    const sum = await run(s, g, clock);
    expect(sum.held).toBe(1);
    expect(g.sent).toHaveLength(0);
    clock.t = 600;
    expect((await run(s, g, clock)).claimed).toBe(0); // account blocked
    clock.t = 5 * 3600;
    expect((await run(s, g, clock)).submitted).toBe(1);
    expect((await jobRow(s)).attempts).toBe(1);
  });

  it('invalid recipient is a final failure and is recorded on the recipient', async () => {
    const { s, g, clock } = await one();
    g.failNext(MockGmail.http(400, 'invalidArgument', 'Invalid To header'));
    await run(s, g, clock);
    const r = await s.db.q(`select status, failure_reason from public.campaign_recipients`);
    expect(r[0].status).toBe('failed');
    expect(r[0].failure_reason).toContain('Invalid To header');
    expect((await jobRow(s)).error_class).toBe('invalid_recipient');
  });

  it('503 is retried with backoff and results in exactly one delivered email', async () => {
    const { s, g, clock } = await one();
    g.failNext(MockGmail.http(503, 'backendError', 'unavailable'));
    expect((await run(s, g, clock)).retried).toBe(1);
    expect(g.sent).toHaveLength(0);
    clock.t = 30;
    expect((await run(s, g, clock)).claimed).toBe(0); // backing off
    clock.t = 400;
    await run(s, g, clock);
    expect(g.sent).toHaveLength(1);
  });

  it('expired Google authorization (invalid_grant) holds the account and notifies the user, nothing is sent', async () => {
    const { s, g, clock } = await one();
    const { ReauthRequired } = await import('../src/tokens');
    const sum = await run(s, g, clock, { getToken: async () => { throw new ReauthRequired('Google rejected the refresh token (invalid_grant)'); } });
    expect(sum.held).toBe(1);
    expect(g.sent).toHaveLength(0);
    expect((await s.db.q(`select status from public.connected_accounts`))[0].status).toBe('reauth_required');
    expect(await count(s.db, `public.notifications where type='failed_sending'`)).toBe(1);
    expect((await run(s, g, clock)).claimed).toBe(0);
  });

  it('LOST RESPONSE after delivery never duplicates: job becomes ambiguous and reconciliation finds the sent message', async () => {
    const { s, g, clock } = await one({ scopes: [GMAIL_SEND_SCOPE, GMAIL_READ_SCOPE] });
    g.failNext(MockGmail.network('socket hang up'), true); // Gmail delivered, response lost
    const sum = await run(s, g, clock);
    expect(sum.ambiguous).toBe(1);
    expect((await jobRow(s)).status).toBe('ambiguous');
    clock.t = 60;
    await run(s, g, clock); // too early to reconcile (<90s): still nothing re-sent
    expect(g.sent).toHaveLength(1);
    clock.t = 200;
    const again = await run(s, g, clock);
    expect(again.reconciled).toBe(1);
    expect(g.sent).toHaveLength(1); // exactly ONE email in total
    expect((await jobRow(s)).status).toBe('submitted');
    expect(await count(s.db, `public.email_messages`)).toBe(1);
  });

  it('LOST RESPONSE before delivery: reconciliation proves it was not sent, then the job is re-queued and sent once', async () => {
    const { s, g, clock } = await one({ scopes: [GMAIL_SEND_SCOPE, GMAIL_READ_SCOPE] });
    g.failNext(MockGmail.network('timeout'), false);
    await run(s, g, clock);
    clock.t = 200;
    await run(s, g, clock);
    expect(g.sent).toHaveLength(0); // not yet 5 minutes: still waiting, never blind-retried
    clock.t = 400;
    await run(s, g, clock); // reconcile: not found + old enough -> requeue (and claim happens in the same run)
    await run(s, g, clock);
    expect(g.sent).toHaveLength(1);
  });

  it('without the read scope an ambiguous job is NEVER retried automatically; the user resolves it', async () => {
    const { s, g, clock } = await one();
    g.failNext(MockGmail.network('reset'), true);
    await run(s, g, clock);
    for (const t of [200, 1000, 100000]) { clock.t = t; await run(s, g, clock); }
    expect(g.sent).toHaveLength(1);
    expect((await jobRow(s)).status).toBe('ambiguous');
    const [{ id }] = await s.db.q(`select id from public.sending_jobs`);
    await s.db.userRpc(s.user, 'resolve_job', { p_job: id, p_outcome: 'sent' });
    expect((await jobRow(s)).status).toBe('submitted');
  });

  it('a bare HTTP 500 is treated as ambiguous too', async () => {
    const { s, g, clock } = await one();
    g.failNext(MockGmail.http(500, 'backendError', 'Internal error'));
    expect((await run(s, g, clock)).ambiguous).toBe(1);
  });

  it('survives a database failure while recording success: no duplicate, resolved by reconciliation', async () => {
    const { s, g, clock } = await one({ scopes: [GMAIL_SEND_SCOPE, GMAIL_READ_SCOPE] });
    let failing = true;
    const flaky: Store = { rpc: async (fn, args) => { if (failing && fn === 'wk_job_complete_sent') throw new Error('connection to database lost'); return s.store.rpc(fn, args as any); } };
    const sum = await run(s, g, clock, { store: flaky });
    expect(sum.errors[0]).toContain('database lost');
    expect(g.sent).toHaveLength(1);
    failing = false;
    clock.t = 400; // lease (120 s) expired while 'sending' -> ambiguous -> reconcile
    await run(s, g, clock);
    clock.t = 800;
    await run(s, g, clock);
    expect(g.sent).toHaveLength(1);
    expect((await jobRow(s)).status).toBe('submitted');
  });

  it('a database outage during claim is reported, not thrown, and the next run recovers', async () => {
    const { s, g, clock } = await one();
    let down = true;
    const broken: Store = { rpc: async (fn, args) => { if (down) throw new Error('db down'); return s.store.rpc(fn, args as any); } };
    const sum = await run(s, g, clock, { store: broken });
    expect(sum.errors.length).toBeGreaterThan(0);
    down = false;
    expect((await run(s, g, clock)).submitted).toBe(1);
  });

  it('crash recovery: a worker that died after claiming is replaced after the lease expires, still one email', async () => {
    const { s, g, clock } = await one();
    const dead = await s.store.rpc<any[]>('wk_claim_jobs', { p_limit: 1, p_lease_seconds: 60, p_worker: 'crashed', p_now: at(0) });
    expect(dead).toHaveLength(1);
    expect((await run(s, g, { t: 10 })).claimed).toBe(0);
    clock.t = 300;
    expect((await run(s, g, clock)).submitted).toBe(1);
    expect(g.sent).toHaveLength(1);
  });

  it('overlapping scheduler invocations never double-send', async () => {
    const s = await setup();
    const g = new MockGmail();
    await makeCampaign(s, { n: 5, settings: { min_interval_seconds: 0, max_interval_seconds: 0, daily_limit: 100 } });
    await Promise.all([1, 2, 3, 4].map((i) => runScheduler(deps(s, g, { t: 0 }, { workerId: `w${i}` }), { maxJobs: 3, maxWaitMs: 0 })));
    const to = g.sent.map((m) => m.to);
    expect(new Set(to).size).toBe(to.length);
    expect(await count(s.db, `public.email_messages`)).toBe(to.length);
  });
});

describe('error classification', () => {
  it('maps provider errors to retry / hold / final / ambiguous', () => {
    const k = (e: unknown) => { const v = classifyError(e); return v.kind === 'fail' ? v.cls : v.kind; };
    expect(k(MockGmail.http(401, 'authError'))).toBe('auth');
    expect(k(MockGmail.http(403, 'dailyLimitExceeded'))).toBe('quota');
    expect(k(MockGmail.http(403, 'insufficientPermissions', 'Insufficient Permission'))).toBe('auth');
    expect(k(MockGmail.http(429, 'rateLimitExceeded'))).toBe('quota');
    expect(k(MockGmail.http(400, 'invalidArgument', 'Invalid To header'))).toBe('invalid_recipient');
    expect(k(MockGmail.http(400, 'invalidArgument', 'Bad raw'))).toBe('permanent');
    expect(k(MockGmail.http(502, 'x'))).toBe('transient');
    expect(k(MockGmail.http(503, 'x'))).toBe('transient');
    expect(k(MockGmail.http(500, 'x'))).toBe('ambiguous');
    expect(k(MockGmail.network())).toBe('ambiguous');
    expect(k(new Error('boom'))).toBe('transient');
  });
});

describe('follow-ups, replies and bounces through the engine', () => {
  const steps = [{ delay_minutes: 60, body_html: '<p>Following up, {{FirstName}}</p>' }, { delay_minutes: 60, subject: 'Custom subject', body_html: '<p>Last one</p>' }];
  async function started(scopes = [GMAIL_SEND_SCOPE, GMAIL_READ_SCOPE]) {
    const s = await setup(scopes);
    const g = new MockGmail();
    const c = await makeCampaign(s, { n: 2, settings: { min_interval_seconds: 0, max_interval_seconds: 0 }, followUps: { steps } });
    const clock = { t: 0 };
    await run(s, g, clock); clock.t = 1; await run(s, g, clock);
    return { s, g, c, clock };
  }

  it('sends follow-ups in the same Gmail thread with proper reply headers', async () => {
    const { s, g, clock } = await started();
    expect(g.sent).toHaveLength(2);
    clock.t = 3700;
    await run(s, g, clock); clock.t = 3701; await run(s, g, clock);
    expect(g.sent).toHaveLength(4);
    const f = g.sent[2];
    expect(f.mail.headers['subject']).toBe('Re: Hello First1');
    expect(f.threadIdParam).toBe(g.sent[0].threadId);
    expect(f.mail.headers['in-reply-to']).toBe(g.sent[0].mail.headers['message-id']);
    expect(f.mail.html).toContain('Following up, First1');
    expect(await stat(s, (await s.db.q(`select id from public.campaigns`))[0].id)).toMatchObject({ follow_ups_sent: 2 });
  });

  it('reply detection (read scope) stops follow-ups for that recipient only', async () => {
    const { s, g, clock } = await started();
    g.addInbound({ threadId: g.sent[0].threadId, from: 'Person One <person1@example.com>', snippet: 'Yes, interested!' });
    const inb = await runInbound({ store: s.store, gmail: g, getToken: async () => 't', clock: () => new Date(T0.getTime() + 600_000) });
    expect(inb.replies).toBe(1);
    clock.t = 7200;
    for (let i = 0; i < 4; i++) { await run(s, g, clock); clock.t += 5; }
    const toFollowed = g.sent.slice(2).map((m) => m.to);
    expect(toFollowed).not.toContain('person1@example.com');
    expect(toFollowed).toContain('person2@example.com');
    const [r] = await s.db.q(`select reply_preview, replied_at from public.campaign_recipients where email='person1@example.com'`);
    expect(r.reply_preview).toBe('Yes, interested!');
    // polling again is idempotent
    await runInbound({ store: s.store, gmail: g, getToken: async () => 't', clock: () => new Date(T0.getTime() + 1_200_000) });
    expect(await count(s.db, `public.replies`)).toBe(1);
  });

  it('bounce notices suppress the address; auto-replies and unrelated mail are ignored', async () => {
    const { s, g, clock } = await started();
    g.addInbound({ threadId: g.sent[0].threadId, from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', subject: 'Delivery Status Notification (Failure)', snippet: 'Address not found 550' });
    g.addInbound({ threadId: g.sent[1].threadId, from: 'person2@example.com', subject: 'Out of office', snippet: 'I am away', autoSubmitted: 'auto-replied' });
    g.addInbound({ threadId: 'unrelated-thread', from: 'someone@else.com', snippet: 'hi' });
    const inb = await runInbound({ store: s.store, gmail: g, getToken: async () => 't', clock: () => new Date(T0.getTime() + 600_000) });
    expect(inb).toMatchObject({ replies: 0, bounces: 1, messages: 2 });
    expect((await s.db.q(`select status from public.campaign_recipients where email='person1@example.com'`))[0].status).toBe('bounced');
    expect(await count(s.db, `public.suppression_entries where email='person1@example.com' and reason='bounced'`)).toBe(1);
    clock.t = 7200;
    for (let i = 0; i < 4; i++) { await run(s, g, clock); clock.t += 5; }
    expect(g.sent.slice(2).map((m) => m.to)).toEqual(['person2@example.com']); // person1 bounced (no follow-up); the out-of-office did NOT stop person2
  });

  it('accounts without the read scope are skipped by reply detection (nothing is invented)', async () => {
    const { s, g } = await started([GMAIL_SEND_SCOPE]);
    g.addInbound({ threadId: g.sent[0].threadId, from: 'person1@example.com' });
    const inb = await runInbound({ store: s.store, gmail: g, getToken: async () => 't' });
    expect(inb.accounts).toBe(0);
    expect(await count(s.db, `public.replies`)).toBe(0);
  });

  it('classifies inbound mail', () => {
    expect(classifyInbound({ from: 'MAILER-DAEMON@googlemail.com', subject: 'Delivery Status Notification (Delay)', autoSubmitted: null, snippet: '' })).toBe('bounce_temporary');
    expect(classifyInbound({ from: 'postmaster@x.com', subject: 'Undeliverable: hi', autoSubmitted: null, snippet: '' })).toBe('bounce_permanent');
    expect(classifyInbound({ from: 'a@b.com', subject: 'Re: hi', autoSubmitted: 'auto-generated', snippet: '' })).toBe('auto');
    expect(classifyInbound({ from: 'a@b.com', subject: 'Re: hi', autoSubmitted: 'no', snippet: '' })).toBe('reply');
  });
});

describe('draft delivery mode', () => {
  it('requires the compose scope, then creates Gmail drafts instead of sending', async () => {
    const s = await setup();
    const c = await makeCampaign(s, { n: 2, start: false });
    await s.db.userRpc(s.user, 'save_campaign', { p_id: c.id, p: { delivery_mode: 'draft' } });
    await expect(s.db.userRpc(s.user, 'start_campaign', { p_id: c.id })).rejects.toThrow(/gmail.compose/);
    await s.db.createAccount(s.user, 'sender@gmail.test', [GMAIL_SEND_SCOPE, GMAIL_COMPOSE_SCOPE]);
    await s.db.userRpc(s.user, 'start_campaign', { p_id: c.id });
    const g = new MockGmail();
    await run(s, g, { t: 0 }, {}, 1);
    expect(g.sent).toHaveLength(0);
    expect(g.drafts).toHaveLength(1);
    expect((await s.db.q(`select status from public.campaign_recipients where status='drafted'`)).length).toBe(1);
  });
});

describe('processJob rendering safety', () => {
  it('escapes merge data (CSV XSS) and never lets recipient fields inject headers', async () => {
    const s = await setup();
    const g = new MockGmail();
    await makeCampaign(s, { recipients: [rec(1, { first_name: '<script>alert(1)</script>Bob', company: 'A&B "Co"' })], settings: { min_interval_seconds: 0, max_interval_seconds: 0 } });
    await run(s, g, { t: 0 });
    const m = g.sent[0].mail;
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).toContain('A&amp;B &quot;Co&quot;');
    expect(b64UrlToUtf8).toBeTruthy();
  });
});
