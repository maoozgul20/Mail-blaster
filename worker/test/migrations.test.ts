import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { TestDb } from './helpers/pg';
import { combined } from '../../scripts/combine-migrations.mjs';

describe('migrations', () => {
  it('apply cleanly on PostgreSQL and create all required tables', async () => {
    const db = await TestDb.create();
    const tables = (
      await db.q<{ table_name: string }>(
        `select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`,
      )
    ).map((r) => r.table_name);
    for (const t of [
      'profiles', 'connected_accounts', 'oauth_tokens', 'campaigns', 'campaign_recipients', 'contacts', 'contact_groups',
      'contact_group_members', 'email_templates', 'email_messages', 'sending_jobs', 'follow_up_sequences', 'follow_up_steps',
      'tracking_events', 'replies', 'bounces', 'suppression_entries', 'activity_logs', 'user_settings', 'notifications',
      'unsubscribe_events',
    ]) {
      expect(tables, t).toContain(t);
    }
  });

  it('creates profile, settings and starter templates for a new user', async () => {
    const db = await TestDb.create();
    const u = await db.createUser('a@test.dev');
    expect((await db.q(`select * from public.profiles where id=$1`, [u])).length).toBe(1);
    expect((await db.q(`select * from public.user_settings where user_id=$1`, [u])).length).toBe(1);
    expect((await db.q(`select * from public.email_templates where user_id=$1`, [u])).length).toBeGreaterThanOrEqual(5);
  });
});

describe('single-file install (Supabase SQL Editor path)', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
  it('supabase/all_migrations.sql is up to date (run: npm run migrations:combine)', () => {
    expect(readFileSync(join(root, 'supabase/all_migrations.sql'), 'utf8')).toBe(combined());
  });
  it('the combined file runs as ONE script on an empty database', async () => {
    const pg = new PGlite();
    await pg.exec(`create schema auth; create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}'::jsonb);
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;`);
    await pg.exec(readFileSync(join(root, 'supabase/all_migrations.sql'), 'utf8'));
    const r = await pg.query<{ n: number }>(`select count(*)::int n from information_schema.tables where table_schema='public'`);
    expect(r.rows[0].n).toBeGreaterThanOrEqual(22);
  });
});

describe('deploy script: wrangler.toml [vars] editing', () => {
  const sample = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../wrangler.toml'), 'utf8');
  const vars = { SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_x$&1', API_BASE_URL: 'https://a.workers.dev', FRONTEND_URL: 'https://f.pages.dev', GOOGLE_REDIRECT_URI: 'https://a.workers.dev/cb', ALLOW_SIGNUPS: 'false' };
  for (const eol of ['\n', '\r\n']) {
    it(`updates values and keeps comments intact with ${eol === '\n' ? 'LF' : 'CRLF'} line endings`, async () => {
      const { setVars } = await import('../../scripts/toml-vars.mjs');
      const out = setVars(sample.replace(/\r?\n/g, eol), vars);
      const lines = out.split(eol);
      expect(out.includes(eol === '\n' ? '\r' : '\n\n\n')).toBe(false);
      for (const [k, v] of Object.entries(vars)) expect(lines).toContain(`${k} = ${JSON.stringify(v)}`);
      expect(lines.filter((l) => l.startsWith('SUPABASE_URL')).length).toBe(1);
      expect(lines.some((l) => l.startsWith('# Non-secret configuration.'))).toBe(true);
      expect(out.split(eol).length).toBe(sample.split(/\r?\n/).length);
      // a bare CR inside a TOML comment is invalid, so no line may contain one
      expect(lines.some((l) => l.includes('\r'))).toBe(false);
    });
  }
});
