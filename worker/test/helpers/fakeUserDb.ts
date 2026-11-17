import type { TestDb } from './pg';
import { callRpc } from './pg';
import type { UserDb } from '../../src/deps';

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`bad identifier ${s}`);
  return s;
};

type Cond = { sql: string; params: unknown[] };

/** A tiny PostgREST look-alike (only the subset our routes use) executing real SQL as the `authenticated` role, so RLS applies. */
class Query implements PromiseLike<any> {
  private op: 'select' | 'insert' | 'update' | 'remove' | 'upsert' = 'select';
  private cols = '*';
  private countMode = false;
  private head = false;
  private returning = false;
  private rows: Record<string, unknown>[] = [];
  private patch: Record<string, unknown> = {};
  private conds: Cond[] = [];
  private orders: string[] = [];
  private from = 0;
  private to = -1;
  private lim = -1;
  private mode: 'many' | 'single' | 'maybe' = 'many';
  private conflict = '';
  private ignoreDup = false;

  constructor(private db: TestDb, private uid: string, private table: string) {
    ident(table);
  }

  select(cols = '*', opts?: { count?: string; head?: boolean }) {
    if (this.op === 'select') {
      this.cols = cols;
      this.countMode = !!opts?.count;
      this.head = !!opts?.head;
    } else {
      this.returning = true;
      this.cols = cols;
    }
    return this;
  }
  insert(r: any) { this.op = 'insert'; this.rows = Array.isArray(r) ? r : [r]; return this; }
  upsert(r: any, o?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.op = 'upsert'; this.rows = Array.isArray(r) ? r : [r]; this.conflict = o?.onConflict ?? ''; this.ignoreDup = !!o?.ignoreDuplicates; return this;
  }
  update(p: any) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'remove'; return this; }

  private cond(sql: string, ...params: unknown[]) { this.conds.push({ sql, params }); return this; }
  eq(c: string, v: unknown) { return this.cond(`${ident(c)} = $#`, v); }
  neq(c: string, v: unknown) { return this.cond(`${ident(c)} <> $#`, v); }
  in(c: string, v: unknown[]) { return this.cond(`${ident(c)} = any($#)`, v); }
  ilike(c: string, v: string) { return this.cond(`${ident(c)} ilike $#`, v); }
  is(c: string, v: null) { return this.cond(`${ident(c)} is ${v === null ? 'null' : 'not null'}`); }
  contains(c: string, v: unknown[]) { return this.cond(`${ident(c)} @> $#`, v); }
  not(c: string, op: string, v: string) { return this.cond(`${ident(c)} not ${op === 'like' ? 'like' : 'ilike'} $#`, v); }
  or(expr: string) {
    const parts = expr.split(',').map((p) => {
      const [col, op, ...val] = p.split('.');
      if (op !== 'ilike') throw new Error('fake supports ilike in or()');
      return { col: ident(col), val: val.join('.') };
    });
    return this.cond('(' + parts.map((p) => `${p.col} ilike $#`).join(' or ') + ')', ...parts.map((p) => p.val));
  }
  order(c: string, o?: { ascending?: boolean }) { this.orders.push(`${ident(c)} ${o?.ascending === false ? 'desc' : 'asc'}`); return this; }
  range(a: number, b: number) { this.from = a; this.to = b; return this; }
  limit(n: number) { this.lim = n; return this; }
  single() { this.mode = 'single'; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }

  private whereSql(params: unknown[]) {
    if (!this.conds.length) return '';
    const ph = (v: unknown) => { params.push(v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v); return `$${params.length}`; };
    return ' where ' + this.conds.map((w) => { let i = 0; return w.sql.replace(/\$#/g, () => ph(w.params[i++])); }).join(' and ');
  }

  private build() {
    const params: unknown[] = [];
    const ph = (v: unknown) => { params.push(v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v); return `$${params.length}`; };
    const cols = this.cols === '*' ? '*' : this.cols.split(',').map((c) => ident(c.trim())).join(',');
    const t = `public.${this.table}`;
    const ret = this.returning ? ` returning ${cols}` : ' returning 1 as _';
    if (this.op === 'select') {
      let sql = `select ${cols} from ${t}${this.whereSql(params)}`;
      if (this.orders.length) sql += ` order by ${this.orders.join(', ')}`;
      if (this.to >= 0) sql += ` limit ${this.to - this.from + 1} offset ${this.from}`;
      else if (this.lim >= 0) sql += ` limit ${this.lim}`;
      return { sql, params };
    }
    if (this.op === 'insert' || this.op === 'upsert') {
      const keys = [...new Set(this.rows.flatMap((r) => Object.keys(r)))].map(ident);
      const values = this.rows.map((r) => '(' + keys.map((k) => (r[k] === undefined ? 'default' : ph(r[k]))).join(',') + ')').join(',');
      let sql = `insert into ${t} (${keys.join(',')}) values ${values}`;
      if (this.op === 'upsert') {
        const target = this.conflict.split(',').map((c) => ident(c.trim())).join(',');
        sql += this.ignoreDup ? ` on conflict (${target}) do nothing` : ` on conflict (${target}) do update set ${keys.map((k) => `${k} = excluded.${k}`).join(',')}`;
      }
      return { sql: sql + ret, params };
    }
    if (this.op === 'update') {
      const set = Object.keys(this.patch).map((k) => `${ident(k)} = ${ph(this.patch[k])}`).join(',');
      return { sql: `update ${t} set ${set}${this.whereSql(params)}${ret}`, params };
    }
    return { sql: `delete from ${t}${this.whereSql(params)} returning 1 as _`, params };
  }

  async exec() {
    try {
      return await this.db.pg.transaction(async (tx) => {
        await tx.exec('set local role authenticated');
        await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [this.uid]);
        let count: number | null = null;
        if (this.op === 'select' && this.countMode) {
          const p: unknown[] = [];
          const w = this.whereSql(p);
          count = (await tx.query<{ n: number }>(`select count(*)::int as n from public.${this.table}${w}`, p as any[])).rows[0].n;
        }
        if (this.head) return { data: null, error: null, count };
        const b = this.build();
        const rows = (await tx.query(b.sql, b.params as any[])).rows;
        const data = this.op === 'select' || this.returning ? rows : null;
        if (this.mode === 'single') {
          if (rows.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }, count };
          return { data: rows[0], error: null, count };
        }
        if (this.mode === 'maybe') return { data: rows[0] ?? null, error: null, count };
        return { data, error: null, count };
      });
    } catch (e: any) {
      return { data: null, error: { code: e.code, message: e.message }, count: null };
    }
  }

  then<T1, T2>(res?: (v: any) => T1 | PromiseLike<T1>, rej?: (e: any) => T2 | PromiseLike<T2>) {
    return this.exec().then(res, rej);
  }
}

export function fakeUserDb(db: TestDb, uid: string): UserDb {
  return {
    from: (table: string) => new Query(db, uid, table),
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      try {
        const data = await db.pg.transaction(async (tx) => {
          await tx.exec('set local role authenticated');
          await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
          return callRpc(tx, fn, args);
        });
        return { data, error: null };
      } catch (e: any) {
        return { data: null, error: { code: e.code, message: e.message } };
      }
    },
  };
}
