import { describe, it, expect } from 'vitest';
import { TestDb } from './helpers/pg';

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
