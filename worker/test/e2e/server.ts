/**
 * Full-stack E2E server: the REAL Worker app (all routes, auth middleware, RPCs) on real PostgreSQL (PGlite),
 * with a mock Gmail. Used by the Playwright dashboard/extension tests. Never contacts Google or sends email.
 *   npx tsx test/e2e/server.ts   (PORT=8788)
 */
import { createServer } from 'node:http';
import { TestDb } from '../helpers/pg';
import { fakeUserDb } from '../helpers/fakeUserDb';
import { MockGmail } from '../helpers/mockGmail';
import { createApp } from '../../src/app';
import type { Deps } from '../../src/deps';
import type { Env } from '../../src/env';
import { runScheduler } from '../../src/scheduler';
import { runInbound } from '../../src/inbound';
import { GMAIL_COMPOSE_SCOPE, GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE, SHEETS_SCOPE } from '@mailblaster/shared';

const PORT = Number(process.env.PORT ?? 8788);
const FRONTEND = process.env.FRONTEND_URL ?? 'http://localhost:4173';
const env: Env = {
  SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', GOOGLE_CLIENT_ID: 'e2e-client', GOOGLE_CLIENT_SECRET: 'e2e-secret',
  GOOGLE_REDIRECT_URI: `http://localhost:${PORT}/oauth/google/callback`, API_BASE_URL: `http://localhost:${PORT}`, FRONTEND_URL: FRONTEND,
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173'), ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
};

const db = await TestDb.create();
const gmail = new MockGmail();
const users = new Map<string, { id: string; password: string }>();
const offset = { s: 0 };
const clock = () => new Date(Date.now() + offset.s * 1000);

const session = (id: string, email: string) => ({ access_token: `uid:${id}:${email}`, refresh_token: `refresh:${id}:${email}`, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id, email } });
const deps: Deps = {
  store: () => db.store(),
  userDb: (_e, token) => fakeUserDb(db, token.split(':')[1]),
  auth: () => ({
    async signUp(email, password) {
      if (users.has(email)) throw Object.assign(new Error('User already registered'), { status: 400 });
      const id = await db.createUser(email);
      users.set(email, { id, password });
      await db.createAccount(id, 'me@gmail.test', [GMAIL_SEND_SCOPE, GMAIL_READ_SCOPE, GMAIL_COMPOSE_SCOPE, SHEETS_SCOPE]);
      return { user: { id, email }, session: session(id, email) };
    },
    async signIn(email, password) {
      const u = users.get(email);
      if (!u || u.password !== password) throw Object.assign(new Error('Invalid email or password'), { status: 401 });
      return session(u.id, email);
    },
    async refresh(rt) { const [, id, email] = rt.split(':'); return session(id, email); },
    async getUser(token) { const [k, id, email] = token.split(':'); return k === 'uid' && id ? { id, email } : null; },
    async signOutAll() {}, async deleteUser() {},
  }),
  gmail: () => gmail,
  storage: () => ({ async upload() {}, async download() { return new Uint8Array(); }, async remove() {}, async removePrefix() {} }),
  accessToken: () => async () => 'e2e-token',
  attachmentLoader: () => async (a) => ({ filename: a.name, contentType: a.type, data: new Uint8Array([1]) }),
};
const app = createApp(deps);

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    // ---- test control plane ----
    if (url.pathname.startsWith('/__')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
      const json = (o: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
      if (url.pathname === '/__tick') {
        const { seconds = 0, maxJobs = 1 } = body ? JSON.parse(body.toString()) : {};
        offset.s += seconds;
        const r = await runScheduler({ store: db.store(), gmail, env, getToken: async () => 't', clock, sleep: async () => {}, workerId: 'e2e' }, { maxJobs, maxWaitMs: 0 });
        return json({ ...r, offset: offset.s });
      }
      if (url.pathname === '/__inbound') return json(await runInbound({ store: db.store(), gmail, getToken: async () => 't', clock }));
      if (url.pathname === '/__sent') return json(gmail.sent.map((m) => ({ to: m.to, subject: m.mail.headers.subject, threadId: m.threadId, html: m.mail.html, headers: m.mail.headers })));
      if (url.pathname === '/__reply') { const { threadId, from, snippet } = JSON.parse(body!.toString()); gmail.addInbound({ threadId, from, snippet }); return json({ ok: true }); }
      if (url.pathname === '/__sql') return json(await db.q(JSON.parse(body!.toString()).sql));
      if (url.pathname === '/__health') return json({ ok: true });
      res.writeHead(404).end(); return;
    }

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const r = await app.fetch(new Request(url, { method: req.method, headers, body: body && req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.writeHead(500).end(String(e));
  }
}).listen(PORT, () => console.log(`e2e server on :${PORT}`));
