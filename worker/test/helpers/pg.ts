import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Store } from '../../src/store';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../supabase/migrations');

// Stand-ins for the parts of Supabase that exist outside the `public` schema.
const PRELUDE = `
create schema if not exists auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now());
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to service_role;
`;

type Tx = { query: PGlite['query']; exec: PGlite['exec'] };

export class TestDb {
  constructor(public pg: PGlite) {}

  static async create(): Promise<TestDb> {
    const pg = new PGlite();
    await pg.exec(PRELUDE);
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      try {
        await pg.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
      } catch (e) {
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
    return new TestDb(pg);
  }

  async createUser(email = `u${Math.random().toString(36).slice(2)}@test.dev`): Promise<string> {
    const r = await this.pg.query<{ id: string }>(`insert into auth.users(email) values ($1) returning id`, [email]);
    return r.rows[0].id;
  }

  /** Insert an active Gmail account the way the OAuth callback would. */
  async createAccount(
    userId: string,
    email = 'sender@gmail.test',
    scopes: string[] = ['https://www.googleapis.com/auth/gmail.send'],
  ): Promise<string> {
    const r = await this.pg.query<{ id: string }>(
      `select public.wk_upsert_account($1, $2, 'Sender', $3::text[], 'enc-refresh', 'enc-access', now() + interval '1 hour') as id`,
      [userId, email, scopes],
    );
    return r.rows[0].id;
  }

  /** Run a callback as an authenticated end user (RLS enforced, like PostgREST with a user JWT). */
  async asUser<T>(userId: string, fn: (q: (sql: string, params?: unknown[]) => Promise<any[]>) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (tx) => {
      await tx.exec(`set local role authenticated`);
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      return fn(async (sql, params) => (await tx.query(sql, params as any[])).rows);
    });
  }

  async q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pg.query<T>(sql, params)).rows;
  }

  /** User-scoped RPC (what the Worker does with the caller's JWT). */
  async userRpc<T = any>(userId: string, fn: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.pg.transaction(async (tx) => {
      await tx.exec(`set local role authenticated`);
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      return callRpc<T>(tx, fn, args);
    });
  }

  /** Service-role store: the same interface the production Worker uses. */
  store(): Store {
    return {
      rpc: ((fn: string, args?: Record<string, unknown>) =>
        this.pg.transaction(async (tx) => {
          await tx.exec(`set local role service_role`);
          return callRpc(tx, fn, args ?? {});
        })) as Store['rpc'],
    };
  }
}

type Sig = { names: string[]; types: string[]; retset: boolean; rettype: string };
const sigCache = new Map<string, Sig>();

async function signature(db: Tx, fn: string): Promise<Sig> {
  let sig = sigCache.get(fn);
  if (sig) return sig;
  const r = await db.query<{ names: string[] | null; argtypes: string[] | null; retset: boolean; rettype: string }>(
    `select p.proargnames as names, p.proretset as retset, p.prorettype::regtype::text as rettype,
            (select array_agg(format_type(t, null) order by o) from unnest(p.proargtypes::oid[]) with ordinality as x(t, o)) as argtypes
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $1 order by p.pronargs desc limit 1`,
    [fn],
  );
  if (!r.rows.length) throw new Error(`unknown function ${fn}`);
  const row = r.rows[0];
  sig = { names: row.names ?? [], types: row.argtypes ?? [], retset: row.retset, rettype: row.rettype };
  sigCache.set(fn, sig);
  return sig;
}

/** Mimics PostgREST's `POST /rpc/<fn>` with a JSON body of named arguments. */
export async function callRpc<T>(db: Tx, fn: string, args: Record<string, unknown>): Promise<T> {
  const sig = await signature(db, fn);
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(args)) {
    const i = sig.names.indexOf(k);
    if (i < 0) throw new Error(`function ${fn} has no argument ${k}`);
    const type = sig.types[i];
    const isArr = type.endsWith('[]');
    params.push(v === undefined || v === null ? null : isArr || type === 'jsonb' ? JSON.stringify(v) : v);
    const n = params.length;
    parts.push(isArr ? `${k} => array(select jsonb_array_elements_text($${n}::jsonb))::${type}` : `${k} => $${n}::${type}`);
  }
  const call = `public.${fn}(${parts.join(', ')})`;
  const sql = sig.retset
    ? `select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) as r from ${call} t`
    : sig.rettype === 'void'
      ? `select ${call}, null::jsonb as r`
      : `select to_jsonb(${call}) as r`;
  const res = await db.query<{ r: T }>(sql, params as any[]);
  return (res.rows[0]?.r ?? null) as T;
}
