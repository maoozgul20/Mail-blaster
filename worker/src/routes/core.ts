import type { Hono } from 'hono';
import { z } from 'zod';
import { SCOPE_GROUPS, SHEETS_SCOPE, decryptSecret, type ScopeGroup } from '@mailblaster/shared';
import type { AppEnv } from '../app';
import { HttpError, body, clientIp, unwrap } from '../http';
import { buildAuthUrl, parseSpreadsheetId, revokeToken, scopesForGroups, sheetsInfo, sheetsValues } from '../google';
import { renderEmail } from '../render';
import { classifyError } from '../scheduler';
import type { ClaimedJob } from '../types';
import { signState } from './public';

const validTz = (tz: string) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM');
const followUp = z.object({
  enabled: z.boolean(), delay_days: z.number().min(0.001).max(365), condition: z.enum(['no_reply', 'no_open', 'no_click', 'always']),
  subject: z.string().max(998), body_html: z.string().max(200_000),
});

export const settingsSchema = z.object({
  timezone: z.string().refine(validTz, 'unknown time zone'),
  daily_limit: z.number().int().min(1).max(2000),
  min_interval_seconds: z.number().int().min(0).max(86_400),
  max_interval_seconds: z.number().int().min(0).max(86_400),
  business_hours: z.object({ enabled: z.boolean(), start: hhmm, end: hhmm }).refine((b) => !b.enabled || b.start < b.end, 'start must be before end'),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  track_opens: z.boolean(), track_clicks: z.boolean(),
  tracking_disclosure: z.string().max(500),
  unsubscribe_footer: z.boolean(), unsubscribe_text: z.string().min(1).max(200),
  signature_html: z.string().max(20_000),
  default_followups: z.array(followUp).max(10),
  notifications: z.object({ campaign_completed: z.boolean(), reply_received: z.boolean(), failed_sending: z.boolean(), campaign_paused: z.boolean() }).partial(),
}).partial().strict().refine((s) => s.min_interval_seconds === undefined || s.max_interval_seconds === undefined || s.min_interval_seconds <= s.max_interval_seconds, 'min interval must not exceed max interval');

const ACCOUNT_COLS = 'id,email,display_name,status,scopes,daily_cap,max_concurrent,blocked_until,blocked_reason,last_error,next_send_at,created_at';

const ALLOWED_TYPES: Record<string, string[]> = {
  'application/pdf': ['pdf'], 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/gif': ['gif'], 'text/plain': ['txt'], 'text/csv': ['csv'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
};
const MAX_ATTACHMENT = 2 * 1024 * 1024;

async function limit(c: any, key: string, windowSeconds: number, max: number, msg = 'Too many attempts, please wait and try again') {
  const ok = await c.get('store').rpc('wk_rate_limit', { p_key: key, p_window_seconds: windowSeconds, p_max: max }).catch(() => true);
  if (!ok) throw new HttpError(429, msg);
}

export function coreRoutes(app: Hono<AppEnv>) {
  // ---------------- auth (thin, rate-limited proxy over Supabase Auth) ----------------
  const cred = z.object({ email: z.string().email().max(254), password: z.string().min(8).max(72) });
  app.post('/api/auth/signup', async (c) => {
    if ((c.env as any).ALLOW_SIGNUPS === 'false') throw new HttpError(403, 'Sign-ups are disabled on this deployment');
    await limit(c, `signup:${clientIp(c)}`, 3600, 10);
    const b = await body(c, cred.extend({ full_name: z.string().max(200).optional() }));
    const r = await c.get('deps').auth(c.env).signUp(b.email.toLowerCase(), b.password, b.full_name);
    return c.json({ user: r.user, session: r.session, needs_confirmation: !r.session });
  });
  app.post('/api/auth/login', async (c) => {
    const b = await body(c, cred.extend({ password: z.string().min(1).max(200) }));
    await limit(c, `login:${clientIp(c)}`, 300, 20);
    await limit(c, `login-email:${b.email.toLowerCase()}`, 300, 10);
    return c.json({ session: await c.get('deps').auth(c.env).signIn(b.email.toLowerCase(), b.password) });
  });
  app.post('/api/auth/refresh', async (c) => {
    const b = await body(c, z.object({ refresh_token: z.string().min(10).max(500) }));
    await limit(c, `refresh:${clientIp(c)}`, 300, 60);
    return c.json({ session: await c.get('deps').auth(c.env).refresh(b.refresh_token) });
  });
  app.post('/api/auth/signout-all', async (c) => {
    await c.get('deps').auth(c.env).signOutAll(c.get('token'));
    return c.json({ ok: true });
  });

  // ---------------- profile & settings ----------------
  app.get('/api/me', async (c) => {
    const db = c.get('db'); const u = c.get('user');
    const [settings, profile, accounts, unread] = await Promise.all([
      db.from('user_settings').select('*').eq('user_id', u.id).maybeSingle(),
      db.from('profiles').select('full_name').eq('id', u.id).maybeSingle(),
      db.from('connected_accounts').select(ACCOUNT_COLS).order('created_at'),
      db.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null),
    ]);
    return c.json({
      user: { id: u.id, email: u.email, full_name: unwrap(profile)?.full_name ?? null },
      settings: unwrap(settings), accounts: unwrap(accounts) ?? [], unread_notifications: unread.count ?? 0,
      google_configured: !!c.env.GOOGLE_CLIENT_ID && !!c.env.GOOGLE_CLIENT_SECRET,
    });
  });

  app.put('/api/settings', async (c) => {
    const patch = await body(c, settingsSchema);
    if (Object.keys(patch).length === 0) throw new HttpError(400, 'Nothing to update');
    const { data, error } = await c.get('db').from('user_settings').update(patch).eq('user_id', c.get('user').id).select('*').single();
    if (error?.code === '23514') throw new HttpError(400, 'Invalid settings: the maximum interval must be at least the minimum interval');
    return c.json({ settings: unwrap({ data, error }) });
  });

  app.put('/api/profile', async (c) => {
    const b = await body(c, z.object({ full_name: z.string().max(200) }));
    unwrap(await c.get('db').from('profiles').update({ full_name: b.full_name }).eq('id', c.get('user').id));
    return c.json({ ok: true });
  });

  // ---------------- Gmail accounts / OAuth ----------------
  app.get('/api/accounts', async (c) => c.json({ accounts: unwrap(await c.get('db').from('connected_accounts').select(ACCOUNT_COLS).order('created_at')) ?? [] }));

  app.post('/api/oauth/google/start', async (c) => {
    if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) throw new HttpError(503, 'Google OAuth is not configured on this deployment (see docs/GOOGLE_OAUTH.md)');
    const b = await body(c, z.object({
      groups: z.array(z.enum(['send', 'read', 'compose', 'sheets'])).max(4).default(['send']),
      return_to: z.enum(['dashboard', 'extension']).default('dashboard'),
      login_hint: z.string().email().optional(),
    }));
    const groups = b.groups as ScopeGroup[];
    const state = await signState(c.env.ENCRYPTION_KEY, { u: c.get('user').id, g: groups, r: b.return_to });
    return c.json({ url: buildAuthUrl(c.env, { scopes: scopesForGroups(groups), state, loginHint: b.login_hint }), scopes: scopesForGroups(groups) });
  });

  app.patch('/api/accounts/:id', async (c) => {
    const b = await body(c, z.object({ max_concurrent: z.number().int().min(1).max(5) }));
    const r = await c.get('db').from('connected_accounts').update({ max_concurrent: b.max_concurrent }).eq('id', c.req.param('id')).select(ACCOUNT_COLS).maybeSingle();
    const row = unwrap(r);
    if (!row) throw new HttpError(404, 'Account not found');
    return c.json({ account: row });
  });

  app.delete('/api/accounts/:id', async (c) => {
    const store = c.get('store'); const id = c.req.param('id');
    const acc = await store.rpc<any>('wk_get_account', { p_account: id, p_user: c.get('user').id });
    if (!acc) throw new HttpError(404, 'Account not found');
    const t = await store.rpc<any>('wk_get_tokens', { p_account: id });
    if (t?.refresh_token_enc) {
      try { await revokeToken(await decryptSecret(t.refresh_token_enc, c.env.ENCRYPTION_KEY)); } catch { /* revocation is best effort */ }
    }
    await store.rpc('wk_disconnect_account', { p_account: id });
    return c.json({ ok: true });
  });

  // ---------------- Google Sheets import (optional sheets permission) ----------------
  async function sheetsToken(c: any, accountId?: string) {
    const rows = unwrap(await c.get('db').from('connected_accounts').select('id,scopes,status').eq('status', 'active')) as any[];
    const acc = rows.find((r) => (!accountId || r.id === accountId) && r.scopes.includes(SHEETS_SCOPE));
    if (!acc) throw new HttpError(400, 'Connect a Google account with the optional Google Sheets permission first (Settings → Account & Integrations).');
    return c.get('deps').accessToken(c.env, c.get('store'))(acc.id);
  }
  app.post('/api/sheets/info', async (c) => {
    const b = await body(c, z.object({ spreadsheet: z.string().min(5).max(500), account_id: z.string().uuid().optional() }));
    const id = parseSpreadsheetId(b.spreadsheet);
    if (!id) throw new HttpError(400, 'Paste the full Google Sheets URL or the spreadsheet ID');
    try { return c.json({ spreadsheetId: id, ...(await sheetsInfo(await sheetsToken(c, b.account_id), id)) }); }
    catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, (e as Error).message); }
  });
  app.post('/api/sheets/values', async (c) => {
    const b = await body(c, z.object({ spreadsheetId: z.string().regex(/^[a-zA-Z0-9_-]+$/), sheet: z.string().min(1).max(200), account_id: z.string().uuid().optional() }));
    let values: string[][];
    try { values = await sheetsValues(await sheetsToken(c, b.account_id), b.spreadsheetId, b.sheet); }
    catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, (e as Error).message); }
    const [head = [], ...rest] = values;
    const headers = head.map((h, i) => String(h || `Column ${i + 1}`).trim());
    const rows = rest.filter((r) => r.some((v) => String(v ?? '').trim())).map((r) => Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? '')])));
    return c.json({ headers, rows: rows.slice(0, 5000), truncated: rows.length > 5000 });
  });

  // ---------------- attachments (private storage bucket, strict allow-list) ----------------
  app.post('/api/attachments', async (c) => {
    const len = Number(c.req.header('content-length') ?? 0);
    if (len > MAX_ATTACHMENT + 4096) throw new HttpError(413, 'Attachment is larger than 2 MB');
    const form = await c.req.formData().catch(() => null);
    const file = form?.get('file');
    if (!file || typeof file === 'string') throw new HttpError(400, 'Send the file in a multipart field called "file"');
    const f = file as File;
    if (f.size > MAX_ATTACHMENT) throw new HttpError(413, 'Attachment is larger than 2 MB');
    const ext = (f.name.split('.').pop() ?? '').toLowerCase();
    const allowedExt = ALLOWED_TYPES[f.type];
    if (!allowedExt || !allowedExt.includes(ext)) throw new HttpError(400, 'This file type is not allowed (PDF, images, Office documents, TXT and CSV only)');
    const safe = f.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || `file.${ext}`;
    const path = `${c.get('user').id}/${crypto.randomUUID()}-${safe}`;
    await c.get('deps').storage(c.env).upload(path, new Uint8Array(await f.arrayBuffer()), f.type);
    return c.json({ attachment: { name: safe, path, size: f.size, type: f.type } });
  });
  app.delete('/api/attachments', async (c) => {
    const path = c.req.query('path') ?? '';
    if (!path.startsWith(`${c.get('user').id}/`) || path.includes('..')) throw new HttpError(403, 'Not allowed');
    await c.get('deps').storage(c.env).remove([path]);
    return c.json({ ok: true });
  });

  // ---------------- test email (to the connected account's own address only) ----------------
  app.post('/api/test-email', async (c) => {
    const u = c.get('user');
    await limit(c, `test:${u.id}`, 3600, 20, 'Test email limit reached (20/hour)');
    const b = await body(c, z.object({
      account_id: z.string().uuid().optional(), subject: z.string().max(998), body_html: z.string().max(500_000),
      to: z.string().email().optional(),
      recipient: z.object({ first_name: z.string().optional(), last_name: z.string().optional(), company: z.string().optional(), website: z.string().optional(), position: z.string().optional(), fields: z.record(z.string(), z.string()).optional() }).optional(),
    }));
    const accounts = unwrap(await c.get('db').from('connected_accounts').select('id,email,display_name,status,scopes').eq('status', 'active')) as any[];
    const acc = accounts.find((a) => !b.account_id || a.id === b.account_id);
    if (!acc) throw new HttpError(400, 'Connect a Gmail account first');
    const to = (b.to ?? acc.email).toLowerCase();
    if (![acc.email.toLowerCase(), u.email.toLowerCase()].includes(to)) throw new HttpError(400, 'Test emails can only be sent to your own addresses');
    const settings = unwrap(await c.get('db').from('user_settings').select('*').eq('user_id', u.id).maybeSingle()) ?? {};
    const r = b.recipient ?? {};
    const job: ClaimedJob = {
      job: { id: `test-${crypto.randomUUID()}`, step_number: 0, attempts: 1, idempotency_key: 'test', worker: 'api', claimed_at: new Date().toISOString(), user_id: u.id },
      account: { id: acc.id, email: acc.email, display_name: acc.display_name, scopes: acc.scopes },
      campaign: { id: 'test', name: 'test', subject: b.subject, body_html: b.body_html, body_text: null, delivery_mode: 'send', settings: {}, attachments: [] },
      recipient: { id: 'test', email: to, first_name: r.first_name ?? 'Test', last_name: r.last_name ?? 'Recipient', company: r.company ?? 'Example Co', website: r.website ?? 'example.com', position: r.position ?? null, fields: r.fields ?? {}, token: '0'.repeat(32) },
      step: null, thread: null,
      user_settings: { track_opens: false, track_clicks: false, unsubscribe_footer: false, unsubscribe_text: settings.unsubscribe_text ?? 'Unsubscribe', signature_html: settings.signature_html ?? '', tracking_disclosure: '' },
    };
    const rendered = await renderEmail(job, c.env, { test: true, testPrefix: '[TEST] ' });
    const deps = c.get('deps');
    try {
      const token = await deps.accessToken(c.env, c.get('store'))(acc.id);
      const sent = await deps.gmail(c.env).send(token, rendered.raw);
      return c.json({ ok: true, to, id: sent.id, missing_variables: rendered.missing });
    } catch (e) {
      const v = classifyError(e);
      throw new HttpError(502, v.kind === 'fail' ? v.message : v.message);
    }
  });

  // ---------------- data export & account deletion ----------------
  app.get('/api/account/export', async (c) => {
    const data = unwrap(await c.get('db').rpc('export_my_data'));
    return new Response(JSON.stringify(data, null, 2), {
      headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="mailblaster-export.json"', 'Cache-Control': 'no-store' },
    });
  });

  app.delete('/api/account', async (c) => {
    await body(c, z.object({ confirm: z.literal('DELETE') }));
    const u = c.get('user'); const store = c.get('store'); const deps = c.get('deps');
    const accounts = (unwrap(await c.get('db').from('connected_accounts').select('id')) as any[]) ?? [];
    for (const a of accounts) {
      const t = await store.rpc<any>('wk_get_tokens', { p_account: a.id }).catch(() => null);
      if (t?.refresh_token_enc) { try { await revokeToken(await decryptSecret(t.refresh_token_enc, c.env.ENCRYPTION_KEY)); } catch { /* best effort */ } }
    }
    await deps.storage(c.env).removePrefix(`${u.id}/`).catch(() => undefined);
    await deps.auth(c.env).deleteUser(u.id); // cascades to every table through foreign keys
    return c.json({ ok: true });
  });
}
