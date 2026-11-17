import { describe, it, expect } from 'vitest';
import { setup, makeCampaign, claim, submit, at, T0, rec, count } from './helpers/fixtures';

describe('campaign creation & recipients', () => {
  it('creates one independent recipient record + one job per recipient (no shared To/BCC)', async () => {
    const s = await setup();
    const c = await makeCampaign(s, { n: 100 });
    expect(c.inserted).toBe(100);
    expect(await count(s.db, 'public.campaign_recipients where campaign_id=$1', [c.id])).toBe(100);
    expect(await count(s.db, `public.sending_jobs where campaign_id=$1 and status='queued' and step_number=0`, [c.id])).toBe(100);
    const emails = await s.db.q(`select count(distinct email)::int n from public.campaign_recipients where campaign_id=$1`, [c.id]);
    expect(emails[0].n).toBe(100);
  });

  it('validates, de-duplicates and excludes suppressed / unsubscribed recipients', async () => {
    const s = await setup();
    await s.db.q(`insert into public.suppression_entries(user_id,email,reason) values ($1,'blocked@example.com','manual')`, [s.user]);
    await s.db.q(`insert into public.contacts(user_id,email,subscription_status) values ($1,'unsub@example.com','unsubscribed')`, [s.user]);
    const c = await makeCampaign(s, {
      start: false,
      recipients: [
        rec(1), rec(1, { email: 'PERSON1@example.com' }), // duplicate (case-insensitive)
        { email: 'not-an-email' }, { email: '' }, { email: 'a@b' },
        { email: 'blocked@example.com' }, { email: 'unsub@example.com' }, rec(2),
      ],
    });
    expect(c.inserted).toBe(4); // person1, blocked, unsub, person2
    expect(c.duplicates).toBe(1);
    expect(c.invalid).toBe(3);
    expect(c.suppressed).toBe(2);
    const r = await s.db.userRpc(s.user, 'start_campaign', { p_id: c.id });
    expect(r.queued).toBe(2);
    expect(await count(s.db, `public.campaign_recipients where campaign_id=$1 and status='skipped' and skip_reason='suppressed'`, [c.id])).toBe(2);
  });

  it('refuses to start without an active account, subject or eligible recipients', async () => {
    const s = await setup();
    const empty = await makeCampaign(s, { start: false, recipients: [] });
    await expect(s.db.userRpc(s.user, 'start_campaign', { p_id: empty.id })).rejects.toThrow(/no eligible recipients/);
  });
});

describe('persistent queue: pacing & atomic claim', () => {
  it('sends sequentially with a randomized 10-20 minute gap and never twice', async () => {
    const s = await setup();
    const c = await makeCampaign(s, { n: 12, settings: { min_interval_seconds: 600, max_interval_seconds: 1200 } });
    let now = 0;
    const times: number[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      // nothing else is claimable until the account's pacing gate opens
      const got = await claim(s, at(now));
      expect(got.length).toBe(1);
      expect(seen.has(got[0].job.id)).toBe(false);
      seen.add(got[0].job.id);
      await submit(s, got[0], at(now));
      times.push(now);
      expect((await claim(s, at(now + 1))).length).toBe(0); // too early
      const [{ next }] = await s.db.q<{ next: string }>(`select next_send_at next from public.connected_accounts where id=$1`, [s.account]);
      const gap = (new Date(next).getTime() - new Date(at(now)).getTime()) / 1000;
      expect(gap).toBeGreaterThanOrEqual(600);
      expect(gap).toBeLessThanOrEqual(1200);
      now += gap;
    }
    expect(seen.size).toBe(12);
    const done = await s.db.q(`select status from public.campaigns where id=$1`, [c.id]);
    expect(done[0].status).toBe('completed');
    expect(await count(s.db, `public.email_messages where campaign_id=$1`, [c.id])).toBe(12);
  });

  it('two overlapping scheduler runs can never claim the same job', async () => {
    const s = await setup();
    await makeCampaign(s, { n: 10, settings: { min_interval_seconds: 0, max_interval_seconds: 0, daily_limit: 100 } });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => claim(s, at(0), 5, `w${i}`)));
    const ids = results.flat().map((j) => j.job.id);
    expect(new Set(ids).size).toBe(ids.length);
    // one account, max_concurrent=1 -> exactly one in-flight job
    expect(await count(s.db, `public.sending_jobs where status='claimed'`)).toBe(1);
  });

  it('jobs for different accounts are processed independently', async () => {
    const s = await setup();
    const acc2 = await s.db.createAccount(s.user, 'second@gmail.test');
    await makeCampaign(s, { n: 2, name: 'A' });
    const second = await s.db.userRpc(s.user, 'save_campaign', { p_id: null, p: { name: 'B', subject: 's', body_html: '<p>x</p>', account_id: acc2, recipients: [rec(50), rec(51)] } });
    await s.db.userRpc(s.user, 'start_campaign', { p_id: second.id });
    const got = await claim(s, at(0));
    expect(got.length).toBe(2);
    expect(new Set(got.map((g) => g.account.id)).size).toBe(2);
  });

  it('never marks a job submitted before Gmail confirms (claimed/sending are not sent)', async () => {
    const s = await setup();
    const c = await makeCampaign(s, { n: 1 });
    const [j] = await claim(s, at(0));
    let st = await s.db.q(`select status from public.sending_jobs where id=$1`, [j.job.id]);
    expect(st[0].status).toBe('claimed');
    const rcpt = await s.db.q(`select status, sent_at from public.campaign_recipients where campaign_id=$1`, [c.id]);
    expect(rcpt[0].status).toBe('queued');
    expect(rcpt[0].sent_at).toBeNull();
    await s.store.rpc('wk_job_mark_sending', { p_job: j.job.id, p_worker: 'w1', p_lease_seconds: 120, p_now: at(0) });
    st = await s.db.q(`select status from public.sending_jobs where id=$1`, [j.job.id]);
    expect(st[0].status).toBe('sending');
    expect(await count(s.db, `public.email_messages`)).toBe(0);
  });
});

describe('limits & windows', () => {
  it('enforces the daily limit and resumes the next day', async () => {
    const s = await setup();
    const c = await makeCampaign(s, { n: 6, settings: { daily_limit: 3, min_interval_seconds: 0, max_interval_seconds: 0 } });
    let sent = 0;
    for (let i = 0; i < 6; i++) {
      const got = await claim(s, at(i));
      if (!got.length) break;
      await submit(s, got[0], at(i));
      sent++;
    }
    expect(sent).toBe(3);
    expect((await claim(s, at(100))).length).toBe(0);
    // next UTC day
    const next = at(24 * 3600);
    let more = 0;
    for (let i = 0; i < 6; i++) {
      const got = await claim(s, at(24 * 3600 + i));
      if (!got.length) break;
      await submit(s, got[0], at(24 * 3600 + i));
      more++;
    }
    expect(more).toBe(3);
    expect(next).toBeTruthy();
    expect(await count(s.db, `public.activity_logs where campaign_id=$1 and event_type='daily_limit_reached'`, [c.id])).toBeGreaterThanOrEqual(1);
  });

  it('the provider cap of the account can never be exceeded by fast presets', async () => {
    const s = await setup();
    await s.db.q(`update public.connected_accounts set daily_cap = 2 where id=$1`, [s.account]);
    await makeCampaign(s, { n: 5, settings: { daily_limit: 2000, min_interval_seconds: 5, max_interval_seconds: 10 } });
    let sent = 0;
    for (let i = 0; i < 5; i++) {
      const got = await claim(s, at(i * 20));
      if (!got.length) continue;
      await submit(s, got[0], at(i * 20));
      sent++;
    }
    expect(sent).toBe(2);
  });

  it('respects business hours, weekdays and time zone', async () => {
    const s = await setup();
    await makeCampaign(s, {
      n: 2,
      settings: {
        timezone: 'America/New_York', weekdays: [1, 2, 3, 4, 5], min_interval_seconds: 0, max_interval_seconds: 0,
        business_hours: { enabled: true, start: '09:00', end: '17:00' },
      },
    });
    const sat = '2030-01-05T17:00:00Z'; // Saturday 12:00 New York
    expect((await claim(s, sat)).length).toBe(0);
    const [{ run_after }] = await s.db.q(`select min(run_after) run_after from public.sending_jobs where status='queued'`);
    expect(new Date(run_after).toISOString()).toBe('2030-01-07T14:00:00.000Z'); // Monday 09:00 EST
    expect((await claim(s, '2030-01-07T13:59:00Z')).length).toBe(0);
    expect((await claim(s, '2030-01-07T14:00:00Z')).length).toBe(1);
    // after hours on Monday -> deferred to Tuesday 09:00 EST
    const s2 = await setup();
    await makeCampaign(s2, { n: 1, settings: { timezone: 'America/New_York', business_hours: { enabled: true, start: '09:00', end: '17:00' }, weekdays: [1, 2, 3, 4, 5] } });
    expect((await claim(s2, '2030-01-07T23:30:00Z')).length).toBe(0);
    const [r2] = await s2.db.q(`select min(run_after) run_after from public.sending_jobs where status='queued'`);
    expect(new Date(r2.run_after).toISOString()).toBe('2030-01-08T14:00:00.000Z');
  });

  it('supports a scheduled start and honours the campaign end date', async () => {
    const s = await setup();
    const startAt = at(3600);
    const c = await makeCampaign(s, { n: 2, startAt });
    expect((await s.db.q(`select status from public.campaigns where id=$1`, [c.id]))[0].status).toBe('scheduled');
    // wk_claim_jobs promotes scheduled -> queued once start_at passes (start_at is real-now based; use a far-future p_now)
    expect((await claim(s, at(-3600))).length).toBe(0);
    await s.db.q(`update public.campaigns set start_at = $2, end_at = $3 where id=$1`, [c.id, at(0), at(7200)]);
    await s.db.q(`update public.sending_jobs set run_after = $2 where campaign_id=$1`, [c.id, at(0)]);
    const [j] = await claim(s, at(10));
    expect(j).toBeTruthy();
    expect((await s.db.q(`select status from public.campaigns where id=$1`, [c.id]))[0].status).toBe('running');
    await submit(s, j, at(10));
    // after the end date the remaining job is skipped, not sent
    expect((await claim(s, at(10_000))).length).toBe(0);
    expect(await count(s.db, `public.sending_jobs where campaign_id=$1 and status='skipped'`, [c.id])).toBe(1);
  });
});

describe('pause / resume / cancel', () => {
  it('pause blocks claiming, resume continues, cancel drops everything queued', async () => {
    const s = await setup();
    const c = await makeCampaign(s, { n: 4, settings: { min_interval_seconds: 0, max_interval_seconds: 0 } });
    const [a] = await claim(s, at(0));
    await submit(s, a, at(0));
    await s.db.userRpc(s.user, 'pause_campaign', { p_id: c.id });
    expect((await claim(s, at(5))).length).toBe(0);
    const r = await s.db.userRpc(s.user, 'resume_campaign', { p_id: c.id });
    expect(r.status).toBe('running');
    const [b] = await claim(s, at(10));
    expect(b).toBeTruthy();
    // pausing between claim and send must stop that send
    await s.db.userRpc(s.user, 'pause_campaign', { p_id: c.id });
    const ok = await s.store.rpc('wk_job_mark_sending', { p_job: b.job.id, p_worker: 'w1', p_lease_seconds: 120, p_now: at(11) });
    expect(ok).toBe(false);
    expect((await s.db.q(`select status from public.sending_jobs where id=$1`, [b.job.id]))[0].status).toBe('queued');
    await s.db.userRpc(s.user, 'resume_campaign', { p_id: c.id });
    const out = await s.db.userRpc(s.user, 'cancel_campaign', { p_id: c.id });
    expect(out.cancelled_jobs).toBeGreaterThanOrEqual(2);
    expect((await claim(s, at(20))).length).toBe(0);
    expect(await count(s.db, `public.campaign_recipients where campaign_id=$1 and status='skipped'`, [c.id])).toBeGreaterThanOrEqual(2);
  });

  it('only drafts can be deleted, and duplicates start as fresh drafts', async () => {
    const s = await setup();
    const c = await makeCampaign(s, { n: 2 });
    await expect(s.db.userRpc(s.user, 'delete_campaign', { p_id: c.id })).rejects.toThrow(/only draft/);
    const d = await s.db.userRpc(s.user, 'duplicate_campaign', { p_id: c.id });
    const [row] = await s.db.q(`select status, name from public.campaigns where id=$1`, [d.id]);
    expect(row.status).toBe('draft');
    expect(row.name).toContain('(copy)');
    expect(await count(s.db, `public.campaign_recipients where campaign_id=$1 and status='pending'`, [d.id])).toBe(2);
    await s.db.userRpc(s.user, 'delete_campaign', { p_id: d.id });
    expect(await count(s.db, `public.campaigns where id=$1`, [d.id])).toBe(0);
  });
});

describe('reliability: leases, retries, ambiguity', () => {
  it('re-queues a job whose lease expired BEFORE sending started', async () => {
    const s = await setup();
    await makeCampaign(s, { n: 1, settings: { min_interval_seconds: 0, max_interval_seconds: 0 } });
    const [j] = await claim(s, at(0), 10, 'dead-worker', 60);
    const again = await claim(s, at(300), 10, 'w2', 60);
    expect(again.length).toBe(1);
    expect(again[0].job.id).toBe(j.job.id);
    expect(again[0].job.attempts).toBe(2);
  });

  it('marks a job whose lease expired DURING sending as ambiguous and never retries it blindly', async () => {
    const s = await setup();
    await makeCampaign(s, { n: 1, settings: { min_interval_seconds: 0, max_interval_seconds: 0 } });
    const [j] = await claim(s, at(0), 10, 'w1', 60);
    await s.store.rpc('wk_job_mark_sending', { p_job: j.job.id, p_worker: 'w1', p_lease_seconds: 60, p_now: at(0) });
    expect((await claim(s, at(600))).length).toBe(0);
    const [row] = await s.db.q(`select status, error_class from public.sending_jobs where id=$1`, [j.job.id]);
    expect(row.status).toBe('ambiguous');
    // reconciliation says Gmail does have it -> complete as sent, exactly once
    const res = await s.store.rpc<any>('wk_job_complete_sent', {
      p_job: j.job.id, p_kind: 'sent', p_gmail_message_id: 'gm1', p_thread_id: 't1', p_rfc_id: '<x@y>', p_subject: 's', p_to: j.recipient.email, p_now: at(601),
    });
    expect(res.ok).toBe(true);
    const dup = await s.store.rpc<any>('wk_job_complete_sent', {
      p_job: j.job.id, p_kind: 'sent', p_gmail_message_id: 'gm1', p_thread_id: 't1', p_rfc_id: '<x@y>', p_subject: 's', p_to: j.recipient.email, p_now: at(602),
    });
    expect(dup.duplicate).toBe(true);
    expect(await count(s.db, `public.email_messages`)).toBe(1);
  });

  it('ambiguous + "not found in Gmail" re-queues; user can also resolve manually', async () => {
    const s = await setup();
    await makeCampaign(s, { n: 2, settings: { min_interval_seconds: 0, max_interval_seconds: 0 } });
    const [j] = await claim(s, at(0));
    await s.store.rpc('wk_job_mark_sending', { p_job: j.job.id, p_worker: 'w1', p_lease_seconds: 120, p_now: at(0) });
    await s.store.rpc('wk_job_mark_ambiguous', { p_job: j.job.id, p_message: 'timeout', p_now: at(5) });
    expect(await s.store.rpc('wk_job_requeue_ambiguous', { p_job: j.job.id, p_now: at(6) })).toBe(true);
    expect((await s.db.q(`select status from public.sending_jobs where id=$1`, [j.job.id]))[0].status).toBe('queued');
    const [j2] = await claim(s, at(10));
    await s.store.rpc('wk_job_mark_sending', { p_job: j2.job.id, p_worker: 'w1', p_lease_seconds: 120, p_now: at(10) });
    await s.store.rpc('wk_job_mark_ambiguous', { p_job: j2.job.id, p_message: 'timeout', p_now: at(11) });
    const r = await s.db.userRpc(s.user, 'resolve_job', { p_job: j2.job.id, p_outcome: 'sent' });
    expect(r.ok).toBe(true);
    expect((await s.db.q(`select status from public.sending_jobs where id=$1`, [j2.job.id]))[0].status).toBe('submitted');
  });

  it('retries transient failures with exponential backoff and fails after max attempts', async () => {
    const s = await setup();
    await makeCampaign(s, { n: 1, settings: { min_interval_seconds: 0, max_interval_seconds: 0 } });
    let now = 0;
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      const [j] = await claim(s, at(now));
      expect(j.job.attempts).toBe(attempt);
      await s.store.rpc('wk_job_mark_sending', { p_job: j.job.id, p_worker: 'w1', p_lease_seconds: 120, p_now: at(now) });
      const res = await s.store.rpc<any>('wk_job_complete_failed', { p_job: j.job.id, p_class: 'transient', p_message: '503 backend error', p_block_seconds: 0, p_now: at(now) });
      if (attempt < 5) {
        const [row] = await s.db.q(`select run_after from public.sending_jobs where id=$1`, [j.job.id]);
        const d = (new Date(row.run_after).getTime() - new Date(at(now)).getTime()) / 1000;
        delays.push(d);
        now += d + 1;
        expect(res.final).toBe(false);
      } else {
        expect(res.final).toBe(true);
      }
    }
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(delays[2]).toBeGreaterThan(delays[1]);
    const [row] = await s.db.q(`select j.status, j.error_class, r.status rstatus from public.sending_jobs j join public.campaign_recipients r on r.id=j.recipient_id`);
    expect(row.status).toBe('failed');
    expect(row.error_class).toBe('transient_exhausted');
    expect(row.rstatus).toBe('failed');
    // retry_failed_jobs puts it back
    const c = (await s.db.q(`select campaign_id from public.sending_jobs`))[0].campaign_id;
    expect(await s.db.userRpc(s.user, 'retry_failed_jobs', { p_id: c })).toBe(1);
  });

  it('permanent / invalid recipient failures are final; auth failure holds the account; quota blocks it', async () => {
    const s = await setup();
    await makeCampaign(s, { n: 3, settings: { min_interval_seconds: 0, max_interval_seconds: 0 } });
    const [a] = await claim(s, at(0));
    await s.store.rpc('wk_job_mark_sending', { p_job: a.job.id, p_worker: 'w1', p_lease_seconds: 120, p_now: at(0) });
    await s.store.rpc('wk_job_complete_failed', { p_job: a.job.id, p_class: 'invalid_recipient', p_message: 'Invalid To header', p_block_seconds: 0, p_now: at(0) });
    expect((await s.db.q(`select status from public.sending_jobs where id=$1`, [a.job.id]))[0].status).toBe('failed');

    const [b] = await claim(s, at(5));
    await s.store.rpc('wk_job_mark_sending', { p_job: b.job.id, p_worker: 'w1', p_lease_seconds: 120, p_now: at(5) });
    await s.store.rpc('wk_job_complete_failed', { p_job: b.job.id, p_class: 'quota', p_message: 'dailyLimitExceeded', p_block_seconds: 7200, p_now: at(5) });
    expect((await claim(s, at(100))).length).toBe(0); // account blocked
    const [acc] = await s.db.q(`select blocked_until from public.connected_accounts where id=$1`, [s.account]);
    expect(new Date(acc.blocked_until).toISOString()).toBe(at(5 + 7200));
    const [again] = await claim(s, at(7300));
    expect(again).toBeTruthy();
    expect(again.job.attempts).toBe(b.job.attempts); // quota did not consume an attempt

    await s.store.rpc('wk_job_mark_sending', { p_job: again.job.id, p_worker: 'w1', p_lease_seconds: 120, p_now: at(7300) });
    await s.store.rpc('wk_job_complete_failed', { p_job: again.job.id, p_class: 'auth', p_message: 'invalid_grant', p_block_seconds: 0, p_now: at(7300) });
    expect((await s.db.q(`select status from public.connected_accounts where id=$1`, [s.account]))[0].status).toBe('reauth_required');
    expect((await claim(s, at(9000))).length).toBe(0); // held until the user reauthorizes
    await s.db.createAccount(s.user, 'sender@gmail.test'); // reconnect (same email)
    expect((await s.db.q(`select status from public.connected_accounts where id=$1`, [s.account]))[0].status).toBe('active');
    expect((await claim(s, at(9100))).length).toBe(1);
  });

  it('suppression added after queueing is honoured at send time', async () => {
    const s = await setup();
    const c = await makeCampaign(s, { n: 2, settings: { min_interval_seconds: 0, max_interval_seconds: 0 } });
    await s.db.q(`insert into public.suppression_entries(user_id,email,reason) values ($1,'person1@example.com','manual')`, [s.user]);
    const [j] = await claim(s, at(0));
    expect(j.recipient.email).toBe('person2@example.com');
    expect(await count(s.db, `public.campaign_recipients where campaign_id=$1 and status='skipped'`, [c.id])).toBe(1);
  });
});

describe('follow-ups', () => {
  const steps = [
    { delay_minutes: 60, condition: 'no_reply', subject: '', body_html: '<p>f1 {{FirstName}}</p>' },
    { delay_minutes: 120, condition: 'no_reply', subject: 'Second try', body_html: '<p>f2</p>' },
    { delay_minutes: 240, condition: 'no_reply', subject: '', body_html: '<p>f3</p>' },
  ];

  async function run() {
    const s = await setup();
    const c = await makeCampaign(s, { n: 1, settings: { min_interval_seconds: 0, max_interval_seconds: 0 }, followUps: { steps } });
    const [j] = await claim(s, at(0));
    await submit(s, j, at(0));
    return { s, c, j };
  }

  it('schedules stage 1 after the delay, then each next stage after the previous one is submitted, in the same thread', async () => {
    const { s, j } = await run();
    expect(await claim(s, at(59 * 60))).toHaveLength(0);
    const [f1] = await claim(s, at(61 * 60));
    expect(f1.job.step_number).toBe(1);
    expect(f1.thread?.thread_id).toBe(`th-${j.recipient.id}`);
    expect(f1.step?.body_html).toContain('f1');
    await submit(s, f1, at(61 * 60));
    expect(await claim(s, at(61 * 60 + 119 * 60))).toHaveLength(0);
    const [f2] = await claim(s, at(61 * 60 + 121 * 60));
    expect(f2.job.step_number).toBe(2);
    await submit(s, f2, at(61 * 60 + 121 * 60));
    const base = 61 * 60 + 121 * 60;
    const [f3] = await claim(s, at(base + 241 * 60));
    expect(f3.job.step_number).toBe(3);
    await submit(s, f3, at(base + 241 * 60));
    expect(await count(s.db, `public.email_messages where recipient_id=$1`, [j.recipient.id])).toBe(4);
    expect((await s.db.q(`select follow_ups_sent from public.campaign_recipients where id=$1`, [j.recipient.id]))[0].follow_ups_sent).toBe(3);
  });

  it('never creates a duplicate follow-up job', async () => {
    const { s, j } = await run();
    await s.store.rpc('wk_job_complete_sent', { p_job: j.job.id, p_kind: 'sent', p_gmail_message_id: 'x', p_thread_id: 't', p_rfc_id: 'r', p_subject: 's', p_to: j.recipient.email, p_now: at(1) });
    expect(await count(s.db, `public.sending_jobs where recipient_id=$1 and step_number=1`, [j.recipient.id])).toBe(1);
    await expect(s.db.q(`insert into public.sending_jobs(user_id,campaign_id,recipient_id,account_id,step_number,idempotency_key) select user_id,campaign_id,recipient_id,account_id,1,'dup' from public.sending_jobs where step_number=1`)).rejects.toThrow();
  });

  it('a detected reply cancels pending follow-ups immediately', async () => {
    const { s, j } = await run();
    const r = await s.store.rpc('wk_record_reply', { p_account: s.account, p_thread: `th-${j.recipient.id}`, p_msg: 'reply-1', p_from: 'person1@example.com', p_snippet: 'Sounds good!', p_received: at(600), p_now: at(601) });
    expect(r).toBe('recorded');
    expect(await claim(s, at(5 * 3600))).toHaveLength(0);
    const [row] = await s.db.q(`select replied_at, reply_preview, followups_stopped, stop_reason from public.campaign_recipients where id=$1`, [j.recipient.id]);
    expect(row.replied_at).not.toBeNull();
    expect(row.reply_preview).toBe('Sounds good!');
    expect(row.stop_reason).toBe('reply');
    expect((await s.db.q(`select status from public.sending_jobs where step_number=1`))[0].status).toBe('cancelled');
    // idempotent + own messages ignored
    expect(await s.store.rpc('wk_record_reply', { p_account: s.account, p_thread: `th-${j.recipient.id}`, p_msg: 'reply-1', p_from: 'person1@example.com', p_snippet: 'x', p_received: at(600), p_now: at(602) })).toBe('duplicate');
    expect(await s.store.rpc('wk_record_reply', { p_account: s.account, p_thread: `th-${j.recipient.id}`, p_msg: 'mine', p_from: 'sender@gmail.test', p_snippet: 'x', p_received: at(600), p_now: at(602) })).toBe('self');
  });

  it('unsubscribe, permanent bounce, suppression, manual disable and campaign cancel all stop follow-ups', async () => {
    for (const how of ['unsubscribe', 'bounce', 'suppress', 'disable', 'cancel'] as const) {
      const { s, c, j } = await run();
      if (how === 'unsubscribe') {
        const [{ token }] = await s.db.q(`select token from public.campaign_recipients where id=$1`, [j.recipient.id]);
        const r = await s.store.rpc<any>('wk_record_unsubscribe', { p_token: token, p_method: 'one_click', p_ua: 'test', p_now: at(100) });
        expect(r.ok).toBe(true);
        expect(await count(s.db, `public.suppression_entries where reason='unsubscribed'`)).toBe(1);
        expect(await count(s.db, `public.unsubscribe_events`)).toBe(1);
        expect((await s.db.q(`select subscription_status from public.contacts`)).length).toBe(0);
      }
      if (how === 'bounce') {
        expect(await s.store.rpc('wk_record_bounce', { p_account: s.account, p_thread: `th-${j.recipient.id}`, p_msg: 'bounce-1', p_type: 'permanent', p_reason: '550 no such user', p_now: at(100) })).toBe('recorded');
        expect((await s.db.q(`select status from public.campaign_recipients`))[0].status).toBe('bounced');
        expect(await count(s.db, `public.suppression_entries where reason='bounced'`)).toBe(1);
      }
      if (how === 'suppress') await s.db.q(`insert into public.suppression_entries(user_id,email,reason) values ($1,'person1@example.com','manual')`, [s.user]);
      if (how === 'disable') await s.db.userRpc(s.user, 'set_followups_enabled', { p_id: c.id, p_enabled: false });
      if (how === 'cancel') await s.db.userRpc(s.user, 'cancel_campaign', { p_id: c.id });
      expect(await claim(s, at(6 * 3600)), how).toHaveLength(0);
      expect(await count(s.db, `public.email_messages`), how).toBe(1);
    }
  });

  it('honours "no open" conditions and keeps running after the campaign itself completed', async () => {
    const s = await setup();
    const c = await makeCampaign(s, { n: 2, settings: { min_interval_seconds: 0, max_interval_seconds: 0 }, followUps: { steps: [{ delay_minutes: 30, condition: 'no_open', body_html: '<p>x</p>' }] } });
    const a = (await claim(s, at(0)))[0]; await submit(s, a, at(0));
    const b = (await claim(s, at(1)))[0]; await submit(s, b, at(1));
    expect((await s.db.q(`select status from public.campaigns where id=$1`, [c.id]))[0].status).toBe('completed');
    const [{ token }] = await s.db.q(`select token from public.campaign_recipients where id=$1`, [a.recipient.id]);
    expect((await s.store.rpc<any>('wk_track_open', { p_token: token, p_ua: 'Mozilla', p_now: at(600) })).counted).toBe(true);
    const got = await claim(s, at(3600));
    expect(got).toHaveLength(1);
    expect(got[0].recipient.id).toBe(b.recipient.id); // the opener is skipped
    expect(await count(s.db, `public.sending_jobs where recipient_id=$1 and step_number=1 and status='cancelled'`, [a.recipient.id])).toBe(1);
  });
});

describe('tracking', () => {
  it('records opens and clicks, flags immediate scanner hits as not counted, and never invents data', async () => {
    const s = await setup();
    const c = await makeCampaign(s, { n: 1 });
    const [j] = await claim(s, at(0));
    await submit(s, j, at(0));
    const tok = j.recipient.token;
    expect((await s.store.rpc<any>('wk_track_open', { p_token: tok, p_ua: 'scanner', p_now: at(2) })).counted).toBe(false);
    expect((await s.db.q(`select open_count from public.campaign_recipients where id=$1`, [j.recipient.id]))[0].open_count).toBe(0);
    await s.store.rpc('wk_track_open', { p_token: tok, p_ua: 'Mozilla', p_now: at(120) });
    await s.store.rpc('wk_track_open', { p_token: tok, p_ua: 'Mozilla', p_now: at(500) });
    await s.store.rpc('wk_track_click', { p_token: tok, p_url: 'https://example.com/a', p_ua: 'Mozilla', p_now: at(130) });
    const [r] = await s.db.q(`select open_count, opened_at, last_opened_at, click_count from public.campaign_recipients where id=$1`, [j.recipient.id]);
    expect(r.open_count).toBe(2);
    expect(new Date(r.opened_at).toISOString()).toBe(at(120));
    expect(new Date(r.last_opened_at).toISOString()).toBe(at(500));
    expect(r.click_count).toBe(1);
    expect(await count(s.db, `public.tracking_events where campaign_id=$1`, [c.id])).toBe(4);
    expect((await s.store.rpc<any>('wk_track_open', { p_token: 'nope', p_ua: '', p_now: at(1) })).ok).toBe(false);
  });
});

describe('row level security', () => {
  it('isolates every user-owned table and hides tokens / internal functions', async () => {
    const s = await setup();
    const other = await s.db.createUser('other@test.dev');
    const c = await makeCampaign(s, { n: 2, followUps: { steps: [{ delay_minutes: 5, body_html: 'x' }] } });
    await s.db.q(`insert into public.contacts(user_id,email) values ($1,'secret@example.com')`, [s.user]);

    for (const t of ['campaigns', 'campaign_recipients', 'sending_jobs', 'contacts', 'connected_accounts', 'activity_logs', 'follow_up_steps', 'email_templates']) {
      const rows = await s.db.asUser(other, (q) => q(`select * from public.${t}`));
      expect(rows.filter((r: any) => r.user_id === s.user).length, t).toBe(0);
      if (t !== 'email_templates') expect(rows.length, t).toBe(0);
    }
    expect((await s.db.asUser(s.user, (q) => q(`select * from public.campaign_recipients`))).length).toBe(2);
    await expect(s.db.asUser(s.user, (q) => q(`select * from public.oauth_tokens`))).rejects.toThrow(/permission denied/);
    await expect(s.db.asUser(s.user, (q) => q(`update public.campaigns set status='running'`))).rejects.toThrow(/permission denied/);
    await expect(s.db.asUser(s.user, (q) => q(`insert into public.sending_jobs(user_id,campaign_id,recipient_id,idempotency_key) values (gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'x')`))).rejects.toThrow(/permission denied/);
    await expect(s.db.userRpc(other, 'wk_claim_jobs', {})).rejects.toThrow(/permission denied/);
    await expect(s.db.userRpc(other, 'pause_campaign', { p_id: c.id })).rejects.toThrow(/cannot be paused/);
    await expect(s.db.userRpc(other, 'get_campaign', { p_id: c.id })).resolves.toBeNull();
    await expect(s.db.userRpc(other, 'start_campaign', { p_id: c.id })).rejects.toThrow(/not found/);
    // cannot write rows for another user
    await expect(s.db.asUser(other, (q) => q(`insert into public.contacts(user_id,email) values ($1,'x@example.com')`, [s.user]))).rejects.toThrow(/row-level security/);
    // cannot attach someone else's Gmail account to own campaign
    await expect(s.db.userRpc(other, 'save_campaign', { p_id: null, p: { name: 'x', account_id: s.account } })).rejects.toThrow(/does not belong/);
    // attachments must live under the caller's own prefix
    await expect(s.db.userRpc(s.user, 'save_campaign', { p_id: null, p: { name: 'x', attachments: [{ name: 'a', path: `${other}/a.pdf`, size: 10, type: 'application/pdf' }] } })).rejects.toThrow(/not owned/);
    // anon has nothing
    await expect(s.db.pg.transaction(async (tx) => { await tx.exec('set local role anon'); return tx.query('select * from public.campaigns'); })).rejects.toThrow(/permission denied/);
  });
});

describe('reads', () => {
  it('overview, stats, recipient filters and exports are computed from PostgreSQL', async () => {
    const s = await setup();
    const c = await makeCampaign(s, { n: 4, settings: { min_interval_seconds: 0, max_interval_seconds: 0 } });
    const a = (await claim(s, at(0)))[0]; await submit(s, a, at(0));
    const b = (await claim(s, at(1)))[0]; await submit(s, b, at(1));
    await s.store.rpc('wk_track_open', { p_token: a.recipient.token, p_ua: 'm', p_now: at(100) });
    await s.store.rpc('wk_record_reply', { p_account: s.account, p_thread: `th-${a.recipient.id}`, p_msg: 'r1', p_from: a.recipient.email, p_snippet: 'yes', p_received: at(200), p_now: at(200) });

    const camp = await s.db.userRpc(s.user, 'get_campaign', { p_id: c.id });
    expect(camp.stats).toMatchObject({ total: 4, sent: 2, opened: 1, replied: 1, queued: 2 });
    const lst = await s.db.userRpc(s.user, 'list_campaign_recipients', { p_campaign: c.id, p_filter: 'replied', p_search: null, p_sort: 'email', p_dir: 'asc', p_limit: 10, p_offset: 0 });
    expect(lst.total).toBe(1);
    expect(lst.rows[0].email).toBe(a.recipient.email);
    for (const f of ['all','pending','queued','sent','opened','not_opened','clicked','replied','no_reply','bounced','unsubscribed','failed','skipped']) {
      await s.db.userRpc(s.user, 'list_campaign_recipients', { p_campaign: c.id, p_filter: f, p_search: 'person', p_sort: 'sent_at', p_dir: 'desc', p_limit: 5, p_offset: 0 });
    }
    const noReply = await s.db.userRpc(s.user, 'list_campaign_recipients', { p_campaign: c.id, p_filter: 'no_reply', p_search: null, p_sort: 'email', p_dir: 'asc', p_limit: 10, p_offset: 0 });
    expect(noReply.total).toBe(1);
    await expect(s.db.userRpc(s.user, 'list_campaign_recipients', { p_campaign: c.id, p_filter: "x'; drop table campaigns;--", p_search: null, p_sort: 'email', p_dir: 'asc', p_limit: 1, p_offset: 0 })).rejects.toThrow(/unknown filter/);

    const ov = await s.db.userRpc(s.user, 'overview_stats');
    expect(ov.totals).toMatchObject({ campaigns: 1, recipients: 4, sent: 2, opened: 1, replied: 1, pending: 2 });
    expect(ov.daily).toHaveLength(30);
    expect(ov.recent_replies).toHaveLength(1);
    expect(ov.rates.reply_rate).toBe(50);
    const list = await s.db.userRpc(s.user, 'list_campaigns', { p_status: null, p_search: 'Test', p_limit: 10, p_offset: 0 });
    expect(list.total).toBe(1);
    expect(list.rows[0]).toMatchObject({ sent: 2, opened: 1, replied: 1 });
    const detail = await s.db.userRpc(s.user, 'recipient_detail', { p_recipient: a.recipient.id });
    expect(detail.messages).toHaveLength(1);
    expect(detail.replies).toHaveLength(1);
    const an = await s.db.userRpc(s.user, 'analytics_overview', { p_days: 7 });
    expect(an.daily).toHaveLength(7);
    const exp = await s.db.userRpc(s.user, 'export_my_data');
    expect(exp.campaign_recipients).toHaveLength(4);
    expect(JSON.stringify(exp)).not.toContain('refresh_token');
  });

  it('imports contacts with validation, dedupe, tags and groups; segments resolve dynamically', async () => {
    const s = await setup();
    const [{ id: g }] = await s.db.asUser(s.user, (q) => q(`insert into public.contact_groups(user_id,name) values ($1,'VIPs') returning id`, [s.user]));
    const r = await s.db.userRpc(s.user, 'import_contacts', {
      p_rows: [{ email: 'a@x.com', first_name: 'A', tags: ['vip'] }, { email: 'A@x.com' }, { email: 'bad' }, { email: 'b@x.com', company: 'Acme', tags: ['lead'] }],
      p_group: g, p_consent_source: 'csv import',
    });
    expect(r).toMatchObject({ inserted: 2, invalid: 1, duplicates: 1 });
    const r2 = await s.db.userRpc(s.user, 'import_contacts', { p_rows: [{ email: 'a@x.com', company: 'NewCo', tags: ['more'] }], p_group: null, p_consent_source: 'x' });
    expect(r2).toMatchObject({ inserted: 0, updated: 1 });
    const [a] = await s.db.q(`select first_name, company, tags from public.contacts where email='a@x.com'`);
    expect(a.first_name).toBe('A');
    expect(a.company).toBe('NewCo');
    expect([...a.tags].sort()).toEqual(['more', 'vip']);
    expect(await s.db.userRpc(s.user, 'group_contacts', { p_group: g })).toHaveLength(2);
    const [{ id: seg }] = await s.db.asUser(s.user, (q) => q(`insert into public.contact_groups(user_id,name,is_segment,segment_filter) values ($1,'Leads',true,'{"tags":["lead"]}') returning id`, [s.user]));
    const segContacts = await s.db.userRpc(s.user, 'group_contacts', { p_group: seg });
    expect(segContacts.map((c: any) => c.email)).toEqual(['b@x.com']);
  });
});

describe('rate limiter', () => {
  it('allows N hits per window then blocks', async () => {
    const s = await setup();
    const res: boolean[] = [];
    for (let i = 0; i < 5; i++) res.push(await s.store.rpc<boolean>('wk_rate_limit', { p_key: 'k', p_window_seconds: 60, p_max: 3, p_now: at(i) }));
    expect(res).toEqual([true, true, true, false, false]);
    expect(await s.store.rpc<boolean>('wk_rate_limit', { p_key: 'k', p_window_seconds: 60, p_max: 3, p_now: at(120) })).toBe(true);
  });
});

describe('sanity', () => { it('uses a fixed monday clock', () => expect(T0.getUTCDay()).toBe(1)); });
