import { Hono } from 'hono';
import { ZodError } from 'zod';
import type { Env } from './env';
import type { AuthUser, Deps, UserDb } from './deps';
import { HttpError, clientIp } from './http';
import type { Store } from './store';
import { publicRoutes } from './routes/public';
import { coreRoutes } from './routes/core';
import { campaignRoutes } from './routes/campaigns';
import { dataRoutes } from './routes/data';

export type AppEnv = {
  Bindings: Env;
  Variables: { user: AuthUser; token: string; db: UserDb; store: Store; deps: Deps };
};

const PUBLIC_API = new Set(['/api/auth/signup', '/api/auth/login', '/api/auth/refresh']);

// Best-effort per-isolate limiter (the database-backed limiter protects the unauthenticated endpoints).
const buckets = new Map<string, { n: number; reset: number }>();
function allow(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) {
    if (buckets.size > 5000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
    buckets.set(key, { n: 1, reset: now + windowMs });
    return true;
  }
  return ++b.n <= max;
}

const origin = (u: string) => { try { return new URL(u).origin; } catch { return ''; } };

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('deps', deps);
    // created lazily: endpoints that never touch the database keep working even if a secret is missing
    let real: Store | undefined;
    c.set('store', { rpc: (fn, args) => (real ??= deps.store(c.env)).rpc(fn, args) } as Store);
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (!c.res.headers.has('Content-Security-Policy')) c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  });

  // CORS: only the dashboard origin (+ explicitly allowed development origins) may call the API from a browser.
  app.use('/api/*', async (c, next) => {
    const allowed = new Set([origin(c.env.FRONTEND_URL), ...(c.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => origin(s.trim())).filter(Boolean)]);
    const o = c.req.header('origin');
    // The Chrome extension's service worker sends `Origin: chrome-extension://<id>`. Optionally pin it with ALLOWED_EXTENSION_IDS.
    const extIds = (c.env.ALLOWED_EXTENSION_IDS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (o?.startsWith('chrome-extension://') && (extIds.length === 0 || extIds.includes(o.slice('chrome-extension://'.length)))) allowed.add(o);
    if (o && allowed.has(o)) {
      c.header('Access-Control-Allow-Origin', o);
      c.header('Vary', 'Origin');
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      c.header('Access-Control-Max-Age', '86400');
    }
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    if (o && !allowed.has(o)) return c.json({ error: 'Origin not allowed' }, 403);
    await next();
  });

  // Authentication: Supabase JWT in the Authorization header (no cookies => no CSRF surface).
  app.use('/api/*', async (c, next) => {
    if (PUBLIC_API.has(c.req.path)) return next();
    const m = (c.req.header('authorization') ?? '').match(/^Bearer\s+(.+)$/i);
    if (!m) throw new HttpError(401, 'Missing bearer token');
    const user = await deps.auth(c.env).getUser(m[1]);
    if (!user) throw new HttpError(401, 'Invalid or expired token');
    if (!allow(`u:${user.id}`, 600, 60_000)) throw new HttpError(429, 'Too many requests');
    c.set('user', user);
    c.set('token', m[1]);
    c.set('db', deps.userDb(c.env, m[1]));
    await next();
  });

  publicRoutes(app);
  coreRoutes(app);
  campaignRoutes(app);
  dataRoutes(app);

  app.notFound((c) => c.json({ error: 'Not found' }, 404));
  app.onError((e, c) => {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status as any);
    if (e instanceof ZodError) { const i = e.issues[0]; return c.json({ error: `${i.path.join('.') || 'request'}: ${i.message}` }, 400); }
    const status = (e as any)?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) return c.json({ error: e.message }, status as any);
    console.error('unhandled error', e);
    return c.json({ error: 'Internal error' }, 500);
  });
  return app;
}

export { clientIp };
