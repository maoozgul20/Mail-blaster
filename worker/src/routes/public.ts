import type { Hono } from 'hono';
import { b64UrlToUtf8, encryptSecret, escapeHtml, hmacSign, hmacVerify, randomToken, utf8ToB64Url } from '@mailblaster/shared';
import type { AppEnv } from '../app';
import { clientIp } from '../http';
import { exchangeCode, fetchUserInfo } from '../google';
import { GMAIL_SEND_SCOPE } from '@mailblaster/shared';

const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0));

const page = (title: string, inner: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#0b1020;color:#e5e7eb;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#151b30;border:1px solid #2a3350;border-radius:14px;padding:32px;max-width:440px;margin:16px}h1{font-size:20px;margin:0 0 12px}
p{color:#a8b0c6}button{background:#6366f1;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px;cursor:pointer}</style></head>
<body><main>${inner}</main></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" } },
  );

export interface OAuthState { u: string; g: string[]; r: 'dashboard' | 'extension'; n: string; exp: number }

export async function signState(secret: string, s: Omit<OAuthState, 'n' | 'exp'>): Promise<string> {
  const payload = utf8ToB64Url(JSON.stringify({ ...s, n: randomToken(8), exp: Date.now() + 10 * 60_000 } satisfies OAuthState));
  return `${payload}.${await hmacSign(secret, 'oauth-state', payload)}`;
}
export async function verifyState(secret: string, state: string): Promise<OAuthState | null> {
  const [payload, sig] = state.split('.');
  if (!payload || !sig || !(await hmacVerify(secret, 'oauth-state', payload, sig))) return null;
  try {
    const s = JSON.parse(b64UrlToUtf8(payload)) as OAuthState;
    return s.exp > Date.now() ? s : null;
  } catch { return null; }
}

export function publicRoutes(app: Hono<AppEnv>) {
  app.get('/', (c) => c.json({ name: 'MailBlaster AI API', status: 'ok' }));
  app.get('/health', async (c) => {
    let db = 'ok';
    try { await c.get('store').rpc('wk_rate_limit', { p_key: 'health', p_window_seconds: 60, p_max: 1000000 }); } catch { db = 'unavailable'; }
    return c.json({ status: db === 'ok' ? 'ok' : 'degraded', database: db, time: new Date().toISOString() }, db === 'ok' ? 200 : 503);
  });

  // ---- open tracking pixel: always answers with the GIF (never reveals whether a token exists) ----
  app.get('/t/o/:file', async (c) => {
    const token = c.req.param('file').replace(/\.gif$/i, '');
    if (/^[a-f0-9]{32}$/.test(token)) {
      const work = c.get('store').rpc('wk_track_open', { p_token: token, p_ua: c.req.header('user-agent') ?? '' }).catch((e) => console.error('track_open failed', e));
      try { c.executionCtx.waitUntil(work); } catch { await work; }
    }
    return new Response(GIF, { headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', 'Content-Length': String(GIF.length) } });
  });

  // ---- click tracking: signed URL, so this can never be abused as an open redirect ----
  app.get('/t/c/:token', async (c) => {
    const token = c.req.param('token');
    const u = c.req.query('u') ?? '';
    const s = c.req.query('s') ?? '';
    let url = '';
    try { url = b64UrlToUtf8(u); } catch { /* invalid */ }
    if (!/^https?:\/\//i.test(url) || !(await hmacVerify(c.env.ENCRYPTION_KEY, 'click', `${token}|${url}`, s))) {
      return page('Invalid link', '<h1>This link is not valid</h1><p>The tracking link was modified or has expired.</p>', 400);
    }
    if (/^[a-f0-9]{32}$/.test(token)) {
      const work = c.get('store').rpc('wk_track_click', { p_token: token, p_url: url, p_ua: c.req.header('user-agent') ?? '' }).catch((e) => console.error('track_click failed', e));
      try { c.executionCtx.waitUntil(work); } catch { await work; }
    }
    return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  });

  // ---- unsubscribe: GET shows a confirmation (scanners/prefetchers can't unsubscribe anyone), POST performs it (also RFC 8058 one-click) ----
  app.get('/u/:token', async (c) => {
    const token = c.req.param('token');
    if (!/^[a-f0-9]{32}$/.test(token)) return page('Unsubscribe', '<h1>Link not recognised</h1>', 404);
    const info = await c.get('store').rpc<{ email: string | null; unsubscribed?: boolean }>('wk_unsubscribe_info', { p_token: token }).catch(() => null);
    if (!info?.email) return page('Unsubscribe', '<h1>Link not recognised</h1><p>This unsubscribe link is not valid.</p>', 404);
    if (info.unsubscribed) return page('Unsubscribed', `<h1>You are unsubscribed</h1><p><b>${escapeHtml(info.email)}</b> will not receive further emails from this sender.</p>`);
    return page('Unsubscribe', `<h1>Unsubscribe?</h1><p>Stop all emails to <b>${escapeHtml(info.email)}</b> from this sender.</p><form method="post"><button type="submit">Yes, unsubscribe me</button></form>`);
  });

  app.post('/u/:token', async (c) => {
    const token = c.req.param('token');
    if (!/^[a-f0-9]{32}$/.test(token)) return page('Unsubscribe', '<h1>Link not recognised</h1>', 404);
    const store = c.get('store');
    const ok = await store.rpc<boolean>('wk_rate_limit', { p_key: `unsub:${clientIp(c)}`, p_window_seconds: 60, p_max: 30 }).catch(() => true);
    if (!ok) return page('Slow down', '<h1>Too many requests</h1><p>Please try again in a minute.</p>', 429);
    const form = await c.req.text().catch(() => '');
    const method = /List-Unsubscribe=One-Click/i.test(form) ? 'one_click' : 'link';
    const r = await store.rpc<{ ok: boolean; email?: string }>('wk_record_unsubscribe', { p_token: token, p_method: method, p_ua: c.req.header('user-agent') ?? '' });
    if (!r?.ok) return page('Unsubscribe', '<h1>Link not recognised</h1>', 404);
    if (method === 'one_click') return c.text('OK');
    return page('Unsubscribed', `<h1>You are unsubscribed</h1><p><b>${escapeHtml(r.email ?? '')}</b> will not receive further emails from this sender.</p>`);
  });

  // ---- Google OAuth callback (browser redirect from Google; the signed `state` binds it to the user who started it) ----
  app.get('/oauth/google/callback', async (c) => {
    const fe = c.env.FRONTEND_URL.replace(/\/$/, '');
    const back = (r: 'dashboard' | 'extension', qs: Record<string, string>) => c.redirect(`${fe}/settings/account?${new URLSearchParams({ ...qs, from: r })}`, 302);
    const state = await verifyState(c.env.ENCRYPTION_KEY, c.req.query('state') ?? '');
    if (!state) return page('Authorization failed', '<h1>Authorization failed</h1><p>This sign-in link is invalid or has expired. Please start again from the dashboard.</p>', 400);
    if (c.req.query('error')) return back(state.r, { oauth_error: c.req.query('error')! });
    const code = c.req.query('code');
    if (!code) return back(state.r, { oauth_error: 'missing_code' });
    try {
      const t = await exchangeCode(c.env, code);
      const granted = (t.scope ?? '').split(' ').filter(Boolean);
      if (!granted.includes(GMAIL_SEND_SCOPE)) return back(state.r, { oauth_error: 'send_permission_not_granted' });
      if (!t.refresh_token) return back(state.r, { oauth_error: 'no_refresh_token' });
      const info = await fetchUserInfo(t.access_token);
      if (!info.email) return back(state.r, { oauth_error: 'no_email' });
      info.email = info.email.trim().toLowerCase();
      await c.get('store').rpc('wk_upsert_account', {
        p_user: state.u, p_email: info.email, p_name: info.name ?? null,
        p_scopes: granted.filter((s) => s.startsWith('https://www.googleapis.com/auth/')),
        p_refresh_enc: await encryptSecret(t.refresh_token, c.env.ENCRYPTION_KEY),
        p_access_enc: await encryptSecret(t.access_token, c.env.ENCRYPTION_KEY),
        p_access_expires: new Date(Date.now() + t.expires_in * 1000).toISOString(),
      });
      return back(state.r, { connected: info.email });
    } catch (e) {
      console.error('oauth callback failed', (e as Error).message);
      return back(state.r, { oauth_error: 'exchange_failed' });
    }
  });
}
