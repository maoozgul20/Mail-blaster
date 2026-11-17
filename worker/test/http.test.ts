import { describe, it, expect, vi, afterEach } from 'vitest';
import { setup, makeCampaign, at, rec, count, type Setup } from './helpers/fixtures';
import { fakeUserDb } from './helpers/fakeUserDb';
import { MockGmail } from './helpers/mockGmail';
import { createApp } from '../src/app';
import type { Deps } from '../src/deps';
import type { Env } from '../src/env';
import { signedClickUrl } from '../src/render';
import { getAccessToken, ReauthRequired } from '../src/tokens';
import { decryptSecret, encryptSecret, GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE, SHEETS_SCOPE, utf8ToB64Url } from '@mailblaster/shared';

const KEY = Buffer.alloc(32, 5).toString('base64');
const ENV: Env = {
  SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service',
  GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret', GOOGLE_REDIRECT_URI: 'https://api.test/oauth/google/callback',
  API_BASE_URL: 'https://api.test', FRONTEND_URL: 'https://app.test', ENCRYPTION_KEY: KEY,
};

function harness(s: Setup, extra: Partial<Deps> = {}) {
  const gmail = new MockGmail();
  const files = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  const deps: Deps = {
    store: () => s.store,
    userDb: (_env, token) => fakeUserDb(s.db, token.split(':')[1]),
    auth: () => ({
      async signUp(email) { return { user: { id: 'u1', email }, session: null }; },
      async signIn(email, pw) { if (pw !== 'correct-password') throw Object.assign(new Error('Invalid email or password'), { status: 401 }); return { access_token: 'a', refresh_token: 'r', expires_at: 1, user: { id: 'u1', email } }; },
      async refresh() { return { access_token: 'a2', refresh_token: 'r2', expires_at: 2, user: { id: 'u1', email: 'x@y.z' } }; },
      async getUser(token) { const [k, id, email] = token.split(':'); return k === 'uid' ? { id, email: email ?? 'user@test.dev' } : null; },
      async signOutAll() {},
      async deleteUser(id) { deleted.push(id); },
    }),
    gmail: () => gmail,
    storage: () => ({
      async upload(p, d) { files.set(p, d); },
      async download(p) { const f = files.get(p); if (!f) throw new Error('nf'); return f; },
      async remove(ps) { ps.forEach((p) => files.delete(p)); },
      async removePrefix(prefix) { for (const k of [...files.keys()]) if (k.startsWith(prefix)) files.delete(k); },
    }),
    accessToken: () => async () => 'tok',
    attachmentLoader: () => async (a) => ({ filename: a.name, contentType: a.type, data: new Uint8Array([1]) }),
    ...extra,
  };
  const app = createApp(deps);
  const call = async (user: string | null, method: string, path: string, body?: unknown, init: RequestInit & { env?: Partial<Env> } = {}) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (user) headers.Authorization = `Bearer uid:${user}:user-${user.slice(0, 4)}@test.dev`;
    let b: BodyInit | undefined = init.body as any;
    if (body !== undefined) { b = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const res = await app.request(path, { method, headers, body: b }, { ...ENV, ...init.env });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { app, call, gmail, files, deleted, deps };
}

afterEach(() => vi.unstubAllGlobals());

describe('HTTP security basics', () => {
  it('requires authentication and rejects unknown tokens', async () => {
    const s = await setup();
    const h = harness(s);
    expect((await h.call(null, 'GET', '/api/campaigns')).status).toBe(401);
    const r = await h.app.request('/api/campaigns', { headers: { Authorization: 'Bearer nope' } }, ENV);
    expect(r.status).toBe(401);
    expect((await h.call(s.user, 'GET', '/api/campaigns')).status).toBe(200);
  });

  it('CORS: only the dashboard origin may call the API from a browser; sets security headers', async () => {
    const s = await setup();
    const h = harness(s);
    const ok = await h.app.request('/api/campaigns', { headers: { Origin: 'https://app.test', Authorization: `Bearer uid:${s.user}` } }, ENV);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.test');
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(ok.headers.get('strict-transport-security')).toContain('max-age');
    const bad = await h.app.request('/api/campaigns', { headers: { Origin: 'https://evil.test', Authorization: `Bearer uid:${s.user}` } }, ENV);
    expect(bad.status).toBe(403);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    const pre = await h.app.request('/api/campaigns', { method: 'OPTIONS', headers: { Origin: 'https://app.test' } }, ENV);
    expect(pre.status).toBe(204);
    const dev = await h.app.request('/api/campaigns', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } }, { ...ENV, ALLOWED_ORIGINS: 'http://localhost:5173' });
    expect(dev.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('auth proxy: login errors are generic, brute force is rate limited, sign-ups can be closed', async () => {
    const s = await setup();
    const h = harness(s);
    expect((await h.call(null, 'POST', '/api/auth/login', { email: 'a@b.co', password: 'wrong' })).status).toBe(401);
    expect((await h.call(null, 'POST', '/api/auth/login', { email: 'a@b.co', password: 'correct-password' })).json.session.access_token).toBe('a');
    let last = 200;
    for (let i = 0; i < 12; i++) last = (await h.call(null, 'POST', '/api/auth/login', { email: 'brute@force.co', password: 'x' })).status;
    expect(last).toBe(429);
    expect((await h.call(null, 'POST', '/api/auth/signup', { email: 'new@b.co', password: 'longenough1' })).json.needs_confirmation).toBe(true);
    expect((await h.call(null, 'POST', '/api/auth/signup', { email: 'new@b.co', password: 'longenough1' }, { env: { ALLOW_SIGNUPS: 'false' } })).status).toBe(403);
    expect((await h.call(null, 'POST', '/api/auth/signup', { email: 'bad', password: 'longenough1' })).status).toBe(400);
    expect((await h.call(null, 'POST', '/api/auth/signup', { email: 'a@b.co', password: 'short' })).status).toBe(400);
  });
});

describe('campaign API', () => {
  it('create -> launch -> list -> detail -> pause -> resume -> recipients -> export -> cancel', async () => {
    const s = await setup();
    const h = harness(s);
    const create = await h.call(s.user, 'POST', '/api/campaigns', {
      name: 'Launch', subject: 'Hi {{FirstName}}', body_html: '<p>Hello</p>', launch: true,
      settings: { daily_limit: 30, min_interval_seconds: 600, max_interval_seconds: 1200, timezone: 'Europe/London', weekdays: [1, 2, 3, 4, 5] },
      follow_ups: { enabled: true, steps: [{ delay_days: 3, condition: 'no_reply', body_html: '<p>f1</p>' }, { delay_days: 4, body_html: '<p>f2</p>' }, { delay_days: 7, body_html: '<p>f3</p>' }] },
      recipients: [rec(1), rec(2), rec(2), { email: 'broken' }, rec(3, { fields: { Notes: '=HYPERLINK("http://evil")' } })],
    });
    expect(create.status).toBe(201);
    expect(create.json).toMatchObject({ launched: true, inserted: 3, duplicates: 1, invalid: 1 });
    const id = create.json.id;

    const list = await h.call(s.user, 'GET', '/api/campaigns?search=Launch');
    expect(list.json.total).toBe(1);
    expect(list.json.rows[0]).toMatchObject({ name: 'Launch', status: 'queued', total: 3, pending: 0, queued: 3 });

    const detail = await h.call(s.user, 'GET', `/api/campaigns/${id}`);
    expect(detail.json.follow_ups.steps.map((x: any) => x.delay_days)).toEqual([3, 4, 7]);
    expect(detail.json.settings.timezone).toBe('Europe/London');
    expect(detail.json.account.email).toBe('sender@gmail.test');

    expect((await h.call(s.user, 'POST', `/api/campaigns/${id}/pause`)).json.status).toBe('paused');
    expect((await h.call(s.user, 'POST', `/api/campaigns/${id}/pause`)).status).toBe(400);
    expect((await h.call(s.user, 'POST', `/api/campaigns/${id}/resume`)).json.status).toBe('queued');

    const recs = await h.call(s.user, 'GET', `/api/campaigns/${id}/recipients?filter=queued&sort=email&dir=desc&limit=2`);
    expect(recs.json.total).toBe(3);
    expect(recs.json.rows.map((r: any) => r.email)).toEqual(['person3@example.com', 'person2@example.com']);
    expect((await h.call(s.user, 'GET', `/api/campaigns/${id}/recipients?filter=bogus`)).status).toBe(400);

    const csv = await h.call(s.user, 'GET', `/api/campaigns/${id}/export.csv`);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.text.split('\r\n')[0]).toContain('Email');
    expect(csv.text).toContain('person1@example.com');

    const rid = recs.json.rows[0].id;
    const detailR = await h.call(s.user, 'GET', `/api/recipients/${rid}`);
    expect(detailR.json.recipient.email).toBe('person3@example.com');
    expect(detailR.json.recipient.token).toBeUndefined(); // tracking tokens are never exposed to the dashboard

    const cancel = await h.call(s.user, 'POST', `/api/campaigns/${id}/cancel`);
    expect(cancel.json).toMatchObject({ status: 'cancelled', cancelled_jobs: 3 });
    expect((await h.call(s.user, 'POST', `/api/campaigns/${id}/duplicate`)).status).toBe(201);
  });

  it('draft editing, start validation and deletion', async () => {
    const s = await setup();
    const h = harness(s);
    const d = await h.call(s.user, 'POST', '/api/campaigns', { name: 'Draft', subject: 'S', body_html: '<p>x</p>', recipients: [rec(1)] });
    expect(d.json.launched).toBe(false);
    const id = d.json.id;
    expect((await h.call(s.user, 'PUT', `/api/campaigns/${id}`, { subject: 'Changed', recipients: [rec(1), rec(2)] })).json.inserted).toBe(2);
    expect((await h.call(s.user, 'GET', `/api/campaigns/${id}`)).json.subject).toBe('Changed');
    const bad = await h.call(s.user, 'PUT', `/api/campaigns/${id}`, { settings: { min_interval_seconds: 100, max_interval_seconds: 10 } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/interval/);
    expect((await h.call(s.user, 'PUT', `/api/campaigns/${id}`, { settings: { weekdays: [9] } })).status).toBe(400);
    const start = await h.call(s.user, 'POST', `/api/campaigns/${id}/start`, { start_at: new Date(Date.now() + 3600_000).toISOString() });
    expect(start.json.status).toBe('scheduled');
    expect((await h.call(s.user, 'PUT', `/api/campaigns/${id}`, { subject: 'late edit' })).status).toBe(400);
    expect((await h.call(s.user, 'DELETE', `/api/campaigns/${id}`)).status).toBe(400); // only drafts
    const d2 = await h.call(s.user, 'POST', '/api/campaigns', { name: 'Throwaway' });
    expect((await h.call(s.user, 'DELETE', `/api/campaigns/${d2.json.id}`)).json.ok).toBe(true);
    // validation
    expect((await h.call(s.user, 'POST', '/api/campaigns', { subject: 'no name' })).status).toBe(400);
    expect((await h.call(s.user, 'GET', '/api/campaigns/not-a-uuid')).status).toBe(400);
    expect((await h.call(s.user, 'POST', '/api/campaigns', { name: 'x', launch: true, subject: '', body_html: '' })).json.error).toMatch(/subject is required/);
    expect((await h.call(s.user, 'GET', '/api/campaigns/00000000-0000-0000-0000-000000000000')).status).toBe(404);
  });

  it('other users cannot see or control a campaign', async () => {
    const s = await setup();
    const h = harness(s);
    const other = await s.db.createUser('other@test.dev');
    const c = await makeCampaign(s, { n: 2 });
    expect((await h.call(other, 'GET', `/api/campaigns/${c.id}`)).status).toBe(404);
    expect((await h.call(other, 'POST', `/api/campaigns/${c.id}/pause`)).status).toBe(400);
    expect((await h.call(other, 'POST', `/api/campaigns/${c.id}/cancel`)).status).toBe(400);
    expect((await h.call(other, 'GET', `/api/campaigns/${c.id}/recipients`)).json.total).toBe(0);
    expect((await h.call(other, 'GET', '/api/campaigns')).json.total).toBe(0);
    expect((await h.call(other, 'GET', '/api/overview')).json.totals.recipients).toBe(0);
    expect((await h.call(s.user, 'GET', '/api/overview')).json.totals.recipients).toBe(2);
  });

  it('overview, analytics, activity and notifications come from the database', async () => {
    const s = await setup();
    const h = harness(s);
    await makeCampaign(s, { n: 3 });
    const ov = await h.call(s.user, 'GET', '/api/overview');
    expect(ov.json.totals).toMatchObject({ campaigns: 1, recipients: 3, pending: 3, sent: 0 });
    expect(ov.json.upcoming).toHaveLength(1);
    const an = await h.call(s.user, 'GET', '/api/analytics?days=14');
    expect(an.json.daily).toHaveLength(14);
    const act = await h.call(s.user, 'GET', '/api/activity?limit=10');
    expect(act.json.rows.some((r: any) => r.event_type === 'jobs_queued')).toBe(true);
    expect(act.json.rows[0].campaign_name).toBe('Test campaign');
    await s.db.q(`insert into public.notifications(user_id,type,title) values ($1,'x','Hello')`, [s.user]);
    expect((await h.call(s.user, 'GET', '/api/me')).json.unread_notifications).toBe(1);
    await h.call(s.user, 'POST', '/api/notifications/read', {});
    expect((await h.call(s.user, 'GET', '/api/me')).json.unread_notifications).toBe(0);
  });

  it('resolves ambiguous jobs via the API', async () => {
    const s = await setup();
    const h = harness(s);
    await makeCampaign(s, { n: 1 });
    const [j] = await s.store.rpc<any[]>('wk_claim_jobs', { p_limit: 1, p_lease_seconds: 120, p_worker: 'w', p_now: at(0) });
    await s.store.rpc('wk_job_mark_sending', { p_job: j.job.id, p_worker: 'w', p_lease_seconds: 120, p_now: at(0) });
    await s.store.rpc('wk_job_mark_ambiguous', { p_job: j.job.id, p_message: 'x', p_now: at(1) });
    const ov = await h.call(s.user, 'GET', '/api/overview');
    expect(ov.json.failed_jobs[0].status).toBe('ambiguous');
    const r = await h.call(s.user, 'POST', `/api/jobs/${j.job.id}/resolve`, { outcome: 'retry' });
    expect(r.json.ok).toBe(true);
  });
});

describe('contacts, groups, templates, suppression', () => {
  it('contact CRUD, import, search, tags, export and isolation', async () => {
    const s = await setup();
    const h = harness(s);
    const other = await s.db.createUser('o@test.dev');
    const imp = await h.call(s.user, 'POST', '/api/contacts/import', { rows: [{ email: 'A@x.com', first_name: 'Ann', tags: ['vip'] }, { email: 'a@x.com' }, { email: 'bad' }, { email: 'b@x.com', company: 'Acme' }], consent_source: 'csv' });
    expect(imp.json).toMatchObject({ inserted: 2, invalid: 1, duplicates: 1 });
    expect((await h.call(s.user, 'GET', '/api/contacts?search=acme')).json.total).toBe(1);
    expect((await h.call(s.user, 'GET', '/api/contacts?tag=vip')).json.rows[0].email).toBe('a@x.com');
    // search is injection-safe
    expect((await h.call(s.user, 'GET', '/api/contacts?search=' + encodeURIComponent('x,email.eq.a@x.com'))).status).toBe(200);
    const created = await h.call(s.user, 'POST', '/api/contacts', { email: 'New@X.com', first_name: 'N' });
    expect(created.status).toBe(201);
    expect(created.json.contact.email).toBe('new@x.com');
    expect((await h.call(s.user, 'POST', '/api/contacts', { email: 'new@x.com' })).status).toBe(409);
    expect((await h.call(s.user, 'POST', '/api/contacts', { email: 'nope' })).status).toBe(400);
    const cid = created.json.contact.id;
    expect((await h.call(s.user, 'PATCH', `/api/contacts/${cid}`, { company: 'Newco', tags: ['t'] })).json.contact.company).toBe('Newco');
    expect((await h.call(other, 'PATCH', `/api/contacts/${cid}`, { company: 'Hacked' })).status).toBe(404);
    expect((await h.call(other, 'GET', '/api/contacts')).json.total).toBe(0);
    const csv = await h.call(s.user, 'GET', '/api/contacts/export.csv');
    expect(csv.text).toContain('a@x.com');
    expect((await h.call(s.user, 'DELETE', `/api/contacts/${cid}`)).json.ok).toBe(true);
    expect((await h.call(s.user, 'GET', '/api/contacts')).json.total).toBe(2);
  });

  it('groups, members and segments', async () => {
    const s = await setup();
    const h = harness(s);
    await h.call(s.user, 'POST', '/api/contacts/import', { rows: [{ email: 'a@x.com', tags: ['vip'] }, { email: 'b@x.com', tags: ['lead'], company: 'Acme' }] });
    const contacts = (await h.call(s.user, 'GET', '/api/contacts')).json.rows;
    const g = (await h.call(s.user, 'POST', '/api/groups', { name: 'Team' })).json.group;
    await h.call(s.user, 'POST', `/api/groups/${g.id}/members`, { contact_ids: [contacts[0].id] });
    expect((await h.call(s.user, 'GET', `/api/groups/${g.id}/contacts`)).json.rows).toHaveLength(1);
    expect((await h.call(s.user, 'GET', `/api/contacts?group=${g.id}`)).json.total).toBe(1);
    const seg = (await h.call(s.user, 'POST', '/api/groups', { name: 'Acme leads', is_segment: true, segment_filter: { tags: ['lead'], company: 'acm' } })).json.group;
    expect((await h.call(s.user, 'GET', `/api/groups/${seg.id}/contacts`)).json.rows.map((r: any) => r.email)).toEqual(['b@x.com']);
    expect((await h.call(s.user, 'POST', '/api/groups', { name: 'Team' })).status).toBe(409);
    await h.call(s.user, 'DELETE', `/api/groups/${g.id}/members/${contacts[0].id}`);
    expect((await h.call(s.user, 'GET', `/api/groups/${g.id}/contacts`)).json.rows).toHaveLength(0);
  });

  it('templates: starters exist, create/edit/duplicate/search/delete', async () => {
    const s = await setup();
    const h = harness(s);
    const list = (await h.call(s.user, 'GET', '/api/templates')).json.templates;
    expect(list.length).toBeGreaterThanOrEqual(5);
    const t = (await h.call(s.user, 'POST', '/api/templates', { name: 'Mine', category: 'Sales', subject: 'Hello {{FirstName}}', body_html: '<p>x</p>' })).json.template;
    expect((await h.call(s.user, 'PUT', `/api/templates/${t.id}`, { name: 'Renamed' })).json.template.name).toBe('Renamed');
    const dup = (await h.call(s.user, 'POST', `/api/templates/${t.id}/duplicate`)).json.template;
    expect(dup.name).toBe('Renamed (copy)');
    expect((await h.call(s.user, 'GET', '/api/templates?search=renamed')).json.templates).toHaveLength(2);
    expect((await h.call(s.user, 'DELETE', `/api/templates/${dup.id}`)).json.ok).toBe(true);
  });

  it('suppression list excludes recipients from new campaigns', async () => {
    const s = await setup();
    const h = harness(s);
    expect((await h.call(s.user, 'POST', '/api/suppression', { emails: ['Blocked@Example.com', 'junk'] })).json.added).toBe(1);
    expect((await h.call(s.user, 'POST', '/api/check-suppressed', { emails: ['blocked@example.com', 'ok@example.com'] })).json.suppressed).toEqual(['blocked@example.com']);
    const c = await h.call(s.user, 'POST', '/api/campaigns', { name: 'S', subject: 's', body_html: 'x', recipients: [{ email: 'blocked@example.com' }, { email: 'ok@example.com' }] });
    expect(c.json.suppressed).toBe(1);
    const sup = (await h.call(s.user, 'GET', '/api/suppression')).json;
    expect(sup.total).toBe(1);
    expect((await h.call(s.user, 'DELETE', `/api/suppression/${sup.rows[0].id}`)).json.ok).toBe(true);
  });
});

describe('settings', () => {
  it('validates and persists settings, including follow-up defaults', async () => {
    const s = await setup();
    const h = harness(s);
    const ok = await h.call(s.user, 'PUT', '/api/settings', { daily_limit: 50, timezone: 'Asia/Karachi', business_hours: { enabled: true, start: '09:00', end: '18:00' }, weekdays: [1, 2, 3, 4, 5], track_clicks: false });
    expect(ok.json.settings).toMatchObject({ daily_limit: 50, timezone: 'Asia/Karachi', track_clicks: false });
    expect((await h.call(s.user, 'GET', '/api/me')).json.settings.daily_limit).toBe(50);
    for (const bad of [{ daily_limit: 0 }, { timezone: 'Mars/Base' }, { business_hours: { enabled: true, start: '18:00', end: '09:00' } }, { min_interval_seconds: 500, max_interval_seconds: 100 }, { weekdays: [] }, { evil: 1 }, {}])
      expect((await h.call(s.user, 'PUT', '/api/settings', bad)).status, JSON.stringify(bad)).toBe(400);
    const fu = await h.call(s.user, 'PUT', '/api/settings', { default_followups: [{ enabled: true, delay_days: 2, condition: 'no_open', subject: '', body_html: '<p>x</p>' }] });
    expect(fu.json.settings.default_followups).toHaveLength(1);
    // new campaigns inherit the user's defaults
    const c = await h.call(s.user, 'POST', '/api/campaigns', { name: 'Inherits' });
    expect((await h.call(s.user, 'GET', `/api/campaigns/${c.json.id}`)).json.settings).toMatchObject({ daily_limit: 50, timezone: 'Asia/Karachi', track_clicks: false });
  });
});

describe('Google OAuth', () => {
  it('start: builds a consent URL with separated scopes, offline access and a signed state', async () => {
    const s = await setup();
    const h = harness(s);
    const r = await h.call(s.user, 'POST', '/api/oauth/google/start', { groups: ['send', 'read', 'sheets'] });
    const url = new URL(r.json.url);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(url.searchParams.get('redirect_uri')).toBe(ENV.GOOGLE_REDIRECT_URI);
    const scope = url.searchParams.get('scope')!.split(' ');
    expect(scope).toEqual(expect.arrayContaining([GMAIL_SEND_SCOPE, GMAIL_READ_SCOPE, SHEETS_SCOPE]));
    expect(r.text).not.toContain('client-secret');
    const sendOnly = new URL((await h.call(s.user, 'POST', '/api/oauth/google/start', {})).json.url).searchParams.get('scope')!;
    expect(sendOnly).toContain(GMAIL_SEND_SCOPE);
    expect(sendOnly).not.toContain('readonly');
    expect((await h.call(s.user, 'POST', '/api/oauth/google/start', {}, { env: { GOOGLE_CLIENT_ID: '' } })).status).toBe(503);
  });

  it('callback: exchanges the code, stores ENCRYPTED tokens, never trusts a forged state', async () => {
    const s = await setup();
    const h = harness(s);
    const start = await h.call(s.user, 'POST', '/api/oauth/google/start', { groups: ['send', 'read'] });
    const state = new URL(start.json.url).searchParams.get('state')!;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'ya29.ACCESS', refresh_token: '1//REFRESH', expires_in: 3599, scope: `openid email ${GMAIL_SEND_SCOPE} ${GMAIL_READ_SCOPE}` }));
      if (String(url).includes('userinfo')) return new Response(JSON.stringify({ email: 'Me@Gmail.com', name: 'Me' }));
      throw new Error('unexpected fetch ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    const forged = await h.call(null, 'GET', `/oauth/google/callback?code=abc&state=${state.slice(0, -4)}AAAA`);
    expect(forged.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    const ok = await h.call(null, 'GET', `/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toContain('https://app.test/settings/account?connected=me%40gmail.com');
    const [acc] = await s.db.q(`select id, email, scopes, status from public.connected_accounts where email='me@gmail.com'`);
    expect(acc.scopes).toEqual(expect.arrayContaining([GMAIL_SEND_SCOPE, GMAIL_READ_SCOPE]));
    const [tok] = await s.db.q(`select refresh_token_enc, access_token_enc from public.oauth_tokens where account_id=$1`, [acc.id]);
    expect(tok.refresh_token_enc).not.toContain('REFRESH');
    expect(await decryptSecret(tok.refresh_token_enc, KEY)).toBe('1//REFRESH');
    expect(await decryptSecret(tok.access_token_enc, KEY)).toBe('ya29.ACCESS');
    // the user can see the account but never the token table
    expect((await h.call(s.user, 'GET', '/api/accounts')).json.accounts.map((a: any) => a.email)).toContain('me@gmail.com');
    expect(JSON.stringify((await h.call(s.user, 'GET', '/api/me')).json)).not.toMatch(/REFRESH|refresh_token/);
  });

  it('callback: refuses when Google did not grant the send permission or no refresh token was issued', async () => {
    const s = await setup();
    const h = harness(s);
    const state = new URL((await h.call(s.user, 'POST', '/api/oauth/google/start', {})).json.url).searchParams.get('state')!;
    vi.stubGlobal('fetch', async (url: string) => String(url).includes('token')
      ? new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 10, scope: 'openid email' })) : new Response('{}'));
    const r = await h.call(null, 'GET', `/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(r.headers.get('location')).toContain('oauth_error=send_permission_not_granted');
    const denied = await h.call(null, 'GET', `/oauth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`);
    expect(denied.headers.get('location')).toContain('oauth_error=access_denied');
  });

  it('disconnect revokes at Google, deletes tokens and pauses the account campaigns', async () => {
    const s = await setup();
    const h = harness(s);
    await s.db.q(`update public.oauth_tokens set refresh_token_enc=$1 where account_id=$2`, [await encryptSecret('RT', KEY), s.account]);
    const c = await makeCampaign(s, { n: 1 });
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    expect((await h.call(s.user, 'DELETE', `/api/accounts/${s.account}`)).json.ok).toBe(true);
    expect(String((fetchMock.mock.calls as any)[0][0])).toContain('oauth2.googleapis.com/revoke');
    expect(await count(s.db, `public.oauth_tokens`)).toBe(0);
    expect((await s.db.q(`select status from public.connected_accounts`))[0].status).toBe('disconnected');
    expect((await s.db.q(`select status from public.campaigns where id=$1`, [c.id]))[0].status).toBe('paused');
    const other = await s.db.createUser('x@y.z');
    expect((await h.call(other, 'DELETE', `/api/accounts/${s.account}`)).status).toBe(404);
  });
});

describe('token service', () => {
  it('uses the cached access token, refreshes when expired, and reports revoked/expired grants', async () => {
    const s = await setup();
    const env = { ...ENV };
    await s.db.q(`update public.oauth_tokens set refresh_token_enc=$1, access_token_enc=$2, access_expires_at=now() + interval '1 hour' where account_id=$3`, [await encryptSecret('RT', KEY), await encryptSecret('cached-token', KEY), s.account]);
    const f = vi.fn(async () => new Response(JSON.stringify({ access_token: 'fresh-token', expires_in: 3600 })));
    vi.stubGlobal('fetch', f);
    expect(await getAccessToken(s.store, env, s.account)).toBe('cached-token');
    expect(f).not.toHaveBeenCalled();
    expect(await getAccessToken(s.store, env, s.account, { force: true })).toBe('fresh-token');
    const [row] = await s.db.q(`select access_token_enc from public.oauth_tokens`);
    expect(await decryptSecret(row.access_token_enc, KEY)).toBe('fresh-token');
    // refresh token revoked / expired after 7 days in Google "Testing" mode
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), { status: 400 }));
    await expect(getAccessToken(s.store, env, s.account, { force: true })).rejects.toBeInstanceOf(ReauthRequired);
    // Google outage is transient, not a reauth request
    vi.stubGlobal('fetch', async () => new Response('', { status: 503 }));
    await expect(getAccessToken(s.store, env, s.account, { force: true })).rejects.not.toBeInstanceOf(ReauthRequired);
    // a wrong ENCRYPTION_KEY can never decrypt
    await expect(getAccessToken(s.store, { ...env, ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') }, s.account, { force: true })).rejects.toBeInstanceOf(ReauthRequired);
  });
});

describe('tracking & unsubscribe endpoints', () => {
  async function sentRecipient() {
    const s = await setup();
    const h = harness(s);
    const c = await makeCampaign(s, { n: 2, settings: { min_interval_seconds: 0, max_interval_seconds: 0 }, followUps: { steps: [{ delay_minutes: 30, body_html: 'f' }] } });
    const [j] = await s.store.rpc<any[]>('wk_claim_jobs', { p_limit: 1, p_lease_seconds: 120, p_worker: 'w', p_now: at(0) });
    await s.store.rpc('wk_job_mark_sending', { p_job: j.job.id, p_worker: 'w', p_lease_seconds: 120, p_now: at(0) });
    await s.store.rpc('wk_job_complete_sent', { p_job: j.job.id, p_kind: 'sent', p_gmail_message_id: 'g', p_thread_id: 't', p_rfc_id: 'r', p_subject: 's', p_to: j.recipient.email, p_now: new Date(Date.now() - 3600_000).toISOString() });
    return { s, h, c, token: j.recipient.token as string, rid: j.recipient.id as string };
  }

  it('pixel always returns a GIF, counts real opens, ignores garbage tokens', async () => {
    const { s, h, token, rid } = await sentRecipient();
    const r = await h.app.request(`/t/o/${token}.gif`, { headers: { 'user-agent': 'Mozilla/5.0' } }, ENV);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/gif');
    expect(r.headers.get('cache-control')).toContain('no-store');
    expect(new Uint8Array(await r.arrayBuffer()).slice(0, 3)).toEqual(new Uint8Array([0x47, 0x49, 0x46]));
    expect((await s.db.q(`select open_count from public.campaign_recipients where id=$1`, [rid]))[0].open_count).toBe(1);
    const junk = await h.app.request(`/t/o/${'0'.repeat(32)}.gif`, {}, ENV);
    expect(junk.status).toBe(200);
    expect((await h.app.request('/t/o/%27%3Bdrop.gif', {}, ENV)).status).toBe(200);
  });

  it('click redirect only follows URLs signed by this server (no open redirect) and records the click', async () => {
    const { s, h, token, rid } = await sentRecipient();
    const good = await signedClickUrl(ENV, token, 'https://example.com/pricing?a=1');
    const r = await h.app.request(good.replace('https://api.test', ''), {}, ENV);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('https://example.com/pricing?a=1');
    expect((await s.db.q(`select click_count from public.campaign_recipients where id=$1`, [rid]))[0].click_count).toBe(1);
    const forged = `/t/c/${token}?u=${utf8ToB64Url('https://evil.com')}&s=${good.split('&s=')[1]}`;
    expect((await h.app.request(forged, {}, ENV)).status).toBe(400);
    expect((await h.app.request(`/t/c/${token}?u=${utf8ToB64Url('javascript:alert(1)')}&s=x`, {}, ENV)).status).toBe(400);
    expect((await h.app.request(`/t/c/${token}`, {}, ENV)).status).toBe(400);
    expect((await s.db.q(`select click_count from public.campaign_recipients where id=$1`, [rid]))[0].click_count).toBe(1);
  });

  it('unsubscribe: GET only asks, POST unsubscribes (idempotent), one-click works, follow-ups stop', async () => {
    const { s, h, token, rid } = await sentRecipient();
    const get = await h.app.request(`/u/${token}`, {}, ENV);
    expect(get.status).toBe(200);
    expect(await get.text()).toContain('<form method="post">');
    expect(await count(s.db, `public.suppression_entries`)).toBe(0); // a prefetching scanner can't unsubscribe anyone
    const post = await h.app.request(`/u/${token}`, { method: 'POST' }, ENV);
    expect(post.status).toBe(200);
    expect(await post.text()).toContain('You are unsubscribed');
    expect(await count(s.db, `public.suppression_entries where reason='unsubscribed'`)).toBe(1);
    expect((await s.db.q(`select status, followups_stopped from public.campaign_recipients where id=$1`, [rid]))[0]).toMatchObject({ status: 'unsubscribed', followups_stopped: true });
    expect(await count(s.db, `public.sending_jobs where recipient_id=$1 and status='queued'`, [rid])).toBe(0);
    await h.app.request(`/u/${token}`, { method: 'POST' }, ENV);
    expect(await count(s.db, `public.unsubscribe_events`)).toBe(1);
    expect(await (await h.app.request(`/u/${token}`, {}, ENV)).text()).toContain('You are unsubscribed');
    // RFC 8058 one-click
    const [{ token: t2 }] = await s.db.q(`select token from public.campaign_recipients where id<>$1`, [rid]);
    const one = await h.app.request(`/u/${t2}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' }, ENV);
    expect(one.status).toBe(200);
    expect((await s.db.q(`select method from public.unsubscribe_events order by created_at desc limit 1`))[0].method).toBe('one_click');
    expect((await h.app.request('/u/not-a-token', { method: 'POST' }, ENV)).status).toBe(404);
    expect((await h.app.request(`/u/${'a'.repeat(32)}`, {}, ENV)).status).toBe(404);
    // the unsubscribed address is now excluded from NEW campaigns too
    const c2 = await h.call(s.user, 'POST', '/api/campaigns', { name: 'again', subject: 's', body_html: 'x', recipients: [{ email: 'person1@example.com' }, { email: 'person2@example.com' }, { email: 'fresh@example.com' }] });
    expect(c2.json.suppressed).toBe(2);
  });

  it('health reports database availability', async () => {
    const s = await setup();
    const h = harness(s);
    expect((await h.app.request('/health', {}, ENV)).status).toBe(200);
    const down = createApp({ ...h.deps, store: () => ({ rpc: async () => { throw new Error('db down'); } }) });
    expect((await down.request('/health', {}, ENV)).status).toBe(503);
  });
});

describe('test email, attachments, sheets, export & deletion', () => {
  it('test email goes only to the user own addresses, prefixed and untracked', async () => {
    const s = await setup();
    const h = harness(s);
    const r = await h.call(s.user, 'POST', '/api/test-email', { subject: 'Hi {{FirstName}} {{Nope}}', body_html: '<p>Hello {{FirstName|there}}</p>', recipient: { first_name: 'Sam' } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, to: 'sender@gmail.test', missing_variables: ['Nope'] });
    expect(h.gmail.sent).toHaveLength(1);
    const m = h.gmail.sent[0].mail;
    expect(m.headers.subject).toBe('[TEST] Hi Sam');
    expect(m.html).toContain('Hello Sam');
    expect(m.html).not.toContain('/t/o/');
    expect((await h.call(s.user, 'POST', '/api/test-email', { subject: 's', body_html: 'x', to: 'victim@example.com' })).status).toBe(400);
    expect(h.gmail.sent).toHaveLength(1);
    h.gmail.failNext(MockGmail.http(403, 'dailyLimitExceeded', 'quota'));
    expect((await h.call(s.user, 'POST', '/api/test-email', { subject: 's', body_html: 'x' })).status).toBe(502);
  });

  it('attachments: allow-list, size cap, per-user paths, safe deletion', async () => {
    const s = await setup();
    const h = harness(s);
    const upload = async (name: string, type: string, size = 100) => {
      const fd = new FormData();
      fd.set('file', new File([new Uint8Array(size)], name, { type }));
      return h.call(s.user, 'POST', '/api/attachments', undefined, { body: fd as any });
    };
    const ok = await upload('Offer 2030.pdf', 'application/pdf');
    expect(ok.status).toBe(200);
    expect(ok.json.attachment.path.startsWith(`${s.user}/`)).toBe(true);
    expect(ok.json.attachment.name).toBe('Offer_2030.pdf');
    expect(h.files.size).toBe(1);
    expect((await upload('virus.exe', 'application/octet-stream')).status).toBe(400);
    expect((await upload('evil.pdf.exe', 'application/pdf')).status).toBe(400);
    expect((await upload('page.html', 'text/html')).status).toBe(400);
    expect((await upload('big.pdf', 'application/pdf', 3 * 1024 * 1024)).status).toBe(413);
    expect((await h.call(s.user, 'DELETE', '/api/attachments?path=other-user/file.pdf')).status).toBe(403);
    expect((await h.call(s.user, 'DELETE', `/api/attachments?path=${s.user}/../x`)).status).toBe(403);
    expect((await h.call(s.user, 'DELETE', `/api/attachments?path=${encodeURIComponent(ok.json.attachment.path)}`)).json.ok).toBe(true);
    expect(h.files.size).toBe(0);
    // campaigns cannot reference someone else's files
    const c = await h.call(s.user, 'POST', '/api/campaigns', { name: 'A', attachments: [{ name: 'x.pdf', path: 'someone-else/x.pdf', size: 1, type: 'application/pdf' }] });
    expect(c.status).toBe(400);
  });

  it('google sheets: lists worksheets and reads rows through the optional permission', async () => {
    const s = await setup();
    const h = harness(s);
    expect((await h.call(s.user, 'POST', '/api/sheets/info', { spreadsheet: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit' })).status).toBe(400); // no sheets scope yet
    await s.db.createAccount(s.user, 'sender@gmail.test', [GMAIL_SEND_SCOPE, SHEETS_SCOPE]);
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('/values/')) return new Response(JSON.stringify({ values: [['Email', 'FirstName'], ['a@x.com', 'Ann'], [], ['b@x.com', 'Bob']] }));
      return new Response(JSON.stringify({ properties: { title: 'Leads' }, sheets: [{ properties: { title: 'Sheet1', gridProperties: { rowCount: 10, columnCount: 2 } } }] }));
    });
    const info = await h.call(s.user, 'POST', '/api/sheets/info', { spreadsheet: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0' });
    expect(info.json).toMatchObject({ title: 'Leads', spreadsheetId: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789' });
    expect(info.json.sheets[0].title).toBe('Sheet1');
    const vals = await h.call(s.user, 'POST', '/api/sheets/values', { spreadsheetId: info.json.spreadsheetId, sheet: 'Sheet1' });
    expect(vals.json.headers).toEqual(['Email', 'FirstName']);
    expect(vals.json.rows).toEqual([{ Email: 'a@x.com', FirstName: 'Ann' }, { Email: 'b@x.com', FirstName: 'Bob' }]);
    expect((await h.call(s.user, 'POST', '/api/sheets/info', { spreadsheet: 'not a sheet' })).status).toBe(400);
  });

  it('exports all personal data (no tokens) and deletes the account everywhere', async () => {
    const s = await setup();
    const h = harness(s);
    await makeCampaign(s, { n: 2 });
    h.files.set(`${s.user}/a.pdf`, new Uint8Array([1]));
    const exp = await h.call(s.user, 'GET', '/api/account/export');
    expect(exp.headers.get('content-disposition')).toContain('attachment');
    expect(exp.json.campaigns).toHaveLength(1);
    expect(exp.text).not.toMatch(/refresh_token|enc-refresh/);
    vi.stubGlobal('fetch', async () => new Response('{}'));
    expect((await h.call(s.user, 'DELETE', '/api/account', { confirm: 'nope' })).status).toBe(400);
    expect((await h.call(s.user, 'DELETE', '/api/account', { confirm: 'DELETE' })).json.ok).toBe(true);
    expect(h.deleted).toEqual([s.user]);
    expect(h.files.size).toBe(0);
  });
});
