import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { MimeAttachment } from '@mailblaster/shared';
import type { Env } from './env';
import { HttpGmail, type GmailApi } from './gmail';
import type { Store } from './store';
import { getAccessToken } from './tokens';

export interface AuthUser { id: string; email: string }
export interface Session { access_token: string; refresh_token: string; expires_at: number | null; user: AuthUser }

export interface UserDb {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: any; error: any }>;
  from(table: string): any;
}

export interface AuthApi {
  signUp(email: string, password: string, fullName?: string): Promise<{ user: AuthUser | null; session: Session | null }>;
  signIn(email: string, password: string): Promise<Session>;
  refresh(refreshToken: string): Promise<Session>;
  getUser(token: string): Promise<AuthUser | null>;
  signOutAll(token: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;
}

export interface StorageApi {
  upload(path: string, data: Uint8Array, contentType: string): Promise<void>;
  download(path: string): Promise<Uint8Array>;
  removePrefix(prefix: string): Promise<void>;
  remove(paths: string[]): Promise<void>;
}

/** Everything the HTTP app needs from the outside world; production wiring below, test doubles in /test. */
export interface Deps {
  store(env: Env): Store;
  userDb(env: Env, token: string): UserDb;
  auth(env: Env): AuthApi;
  gmail(env: Env): GmailApi;
  storage(env: Env): StorageApi;
  accessToken(env: Env, store: Store): (accountId: string, force?: boolean) => Promise<string>;
  attachmentLoader(env: Env): (a: { name: string; path: string; type: string }, userId: string) => Promise<MimeAttachment>;
}

/**
 * Supabase's newer API keys (sb_publishable_… / sb_secret_…) are NOT JWTs and belong only in the `apikey` header.
 * supabase-js also sends the key as `Authorization: Bearer`, which the gateway can reject for non-JWT keys, so strip it then.
 * Legacy anon/service_role JWT keys and user JWTs are left untouched.
 */
export const keyAwareFetch: typeof fetch = (input, init) => {
  const h = new Headers(init?.headers);
  if ((h.get('authorization') ?? '').replace(/^Bearer\s+/i, '').startsWith('sb_')) h.delete('authorization');
  return fetch(input, { ...init, headers: h });
};

const noPersist = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: keyAwareFetch } };

const service = (env: Env): SupabaseClient => createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, noPersist);

const toSession = (s: any): Session => ({
  access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at ?? null,
  user: { id: s.user.id, email: s.user.email ?? '' },
});

export const productionDeps: Deps = {
  store: (env) => {
    const c = service(env);
    return {
      async rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
        const { data, error } = await c.rpc(fn, args ?? {});
        if (error) throw new Error(`${fn}: ${error.message}`);
        return data as T;
      },
    };
  },
  userDb: (env, token) =>
    createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { ...noPersist, global: { fetch: keyAwareFetch, headers: { Authorization: `Bearer ${token}` } } }) as unknown as UserDb,
  auth: (env) => {
    const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, noPersist);
    const admin = service(env);
    return {
      async signUp(email, password, fullName) {
        const { data, error } = await anon.auth.signUp({ email, password, options: { data: fullName ? { full_name: fullName } : {} } });
        if (error) throw Object.assign(new Error(error.message), { status: 400 });
        return {
          user: data.user ? { id: data.user.id, email: data.user.email ?? email } : null,
          session: data.session ? toSession(data.session) : null,
        };
      },
      async signIn(email, password) {
        const { data, error } = await anon.auth.signInWithPassword({ email, password });
        if (error || !data.session) throw Object.assign(new Error('Invalid email or password'), { status: 401 });
        return toSession(data.session);
      },
      async refresh(refreshToken) {
        const { data, error } = await anon.auth.refreshSession({ refresh_token: refreshToken });
        if (error || !data.session) throw Object.assign(new Error('Session expired, please sign in again'), { status: 401 });
        return toSession(data.session);
      },
      async getUser(token) {
        const { data, error } = await anon.auth.getUser(token);
        return error || !data.user ? null : { id: data.user.id, email: data.user.email ?? '' };
      },
      async signOutAll(token) {
        await admin.auth.admin.signOut(token, 'global');
      },
      async deleteUser(userId) {
        const { error } = await admin.auth.admin.deleteUser(userId);
        if (error) throw new Error(error.message);
      },
    };
  },
  gmail: (env) => new HttpGmail(env.GMAIL_API_BASE),
  storage: (env) => {
    const bucket = () => service(env).storage.from('attachments');
    return {
      async upload(path, data, contentType) {
        const { error } = await bucket().upload(path, data, { contentType, upsert: false });
        if (error) throw new Error(error.message);
      },
      async download(path) {
        const { data, error } = await bucket().download(path);
        if (error || !data) throw new Error(error?.message ?? 'attachment not found');
        return new Uint8Array(await data.arrayBuffer());
      },
      async remove(paths) {
        if (paths.length) await bucket().remove(paths);
      },
      async removePrefix(prefix) {
        const b = bucket();
        const { data } = await b.list(prefix.replace(/\/$/, ''), { limit: 1000 });
        if (data?.length) await b.remove(data.map((f) => `${prefix.replace(/\/$/, '')}/${f.name}`));
      },
    };
  },
  accessToken: (env, store) => (accountId, force) => getAccessToken(store, env, accountId, { force }),
  attachmentLoader: (env) => {
    const st = productionDeps.storage(env);
    return async (a, userId) => {
      if (!a.path.startsWith(`${userId}/`)) throw new Error('attachment path does not belong to the campaign owner');
      return { filename: a.name, contentType: a.type, data: await st.download(a.path) };
    };
  },
};
