import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app';
import { HttpError, body, toCsv, unwrap } from '../http';
import { isValidEmail, normalizeEmail } from '@mailblaster/shared';

const uuid = z.string().uuid();
const pageQ = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).max(1_000_000).default(0), search: z.string().max(200).optional() });
// PostgREST filter values must not contain separators that would change the filter expression.
const safeLike = (s: string) => s.replace(/[,()*%\\]/g, ' ').trim();

const contactIn = z.object({
  email: z.string().max(320), first_name: z.string().max(200).nullish(), last_name: z.string().max(200).nullish(), company: z.string().max(300).nullish(),
  website: z.string().max(300).nullish(), position: z.string().max(300).nullish(), custom_fields: z.record(z.string(), z.string().max(2000)).optional(),
  tags: z.array(z.string().max(50)).max(30).optional(), subscription_status: z.enum(['subscribed', 'unsubscribed', 'cleaned']).optional(),
  consent_source: z.string().max(200).nullish(), consent_notes: z.string().max(1000).nullish(),
});

export function dataRoutes(app: Hono<AppEnv>) {
  const id = (c: any, name = 'id') => { const p = uuid.safeParse(c.req.param(name)); if (!p.success) throw new HttpError(400, 'Invalid id'); return p.data as string; };

  // ---------------- contacts ----------------
  app.get('/api/contacts', async (c) => {
    const q = pageQ.extend({ tag: z.string().max(50).optional(), status: z.enum(['subscribed', 'unsubscribed', 'cleaned']).optional(), group: uuid.optional() }).parse(c.req.query());
    const db = c.get('db');
    if (q.group) {
      const rows = unwrap(await db.rpc('group_contacts', { p_group: q.group })) as any[];
      const s = (q.search ?? '').toLowerCase();
      const filtered = rows.filter((r) => !s || [r.email, r.first_name, r.last_name, r.company].some((v: string | null) => (v ?? '').toLowerCase().includes(s)));
      return c.json({ total: filtered.length, rows: filtered.slice(q.offset, q.offset + q.limit) });
    }
    let query = db.from('contacts').select('*', { count: 'exact' });
    if (q.search) { const s = safeLike(q.search); query = query.or(`email.ilike.%${s}%,first_name.ilike.%${s}%,last_name.ilike.%${s}%,company.ilike.%${s}%`); }
    if (q.tag) query = query.contains('tags', [q.tag]);
    if (q.status) query = query.eq('subscription_status', q.status);
    const r = await query.order('created_at', { ascending: false }).range(q.offset, q.offset + q.limit - 1);
    return c.json({ total: r.count ?? 0, rows: unwrap(r) ?? [] });
  });

  app.post('/api/contacts', async (c) => {
    const b = await body(c, contactIn);
    const email = normalizeEmail(b.email);
    if (!isValidEmail(email)) throw new HttpError(400, 'Invalid email address');
    const r = await c.get('db').from('contacts').insert({ ...b, email, user_id: c.get('user').id, consent_at: new Date().toISOString() }).select('*').single();
    return c.json({ contact: unwrap(r) }, 201);
  });

  app.post('/api/contacts/import', async (c) => {
    const b = await body(c, z.object({ rows: z.array(z.record(z.string(), z.any())).max(10_000), group_id: uuid.nullish(), consent_source: z.string().max(200).default('import') }));
    return c.json(unwrap(await c.get('db').rpc('import_contacts', { p_rows: b.rows, p_group: b.group_id ?? null, p_consent_source: b.consent_source })));
  });

  app.patch('/api/contacts/:id', async (c) => {
    const b = await body(c, contactIn.partial());
    if (b.email !== undefined) { b.email = normalizeEmail(b.email); if (!isValidEmail(b.email)) throw new HttpError(400, 'Invalid email address'); }
    const r = await c.get('db').from('contacts').update(b).eq('id', id(c)).select('*').maybeSingle();
    const row = unwrap(r);
    if (!row) throw new HttpError(404, 'Contact not found');
    return c.json({ contact: row });
  });
  app.delete('/api/contacts/:id', async (c) => { unwrap(await c.get('db').from('contacts').delete().eq('id', id(c))); return c.json({ ok: true }); });
  app.post('/api/contacts/bulk-delete', async (c) => {
    const b = await body(c, z.object({ ids: z.array(uuid).min(1).max(1000) }));
    unwrap(await c.get('db').from('contacts').delete().in('id', b.ids));
    return c.json({ ok: true, deleted: b.ids.length });
  });
  app.get('/api/contacts/export.csv', async (c) => {
    const all: any[] = [];
    for (let off = 0; off < 20_000; off += 1000) {
      const rows = unwrap(await c.get('db').from('contacts').select('*').order('created_at').range(off, off + 999)) as any[];
      all.push(...rows);
      if (rows.length < 1000) break;
    }
    const csv = toCsv(['Email', 'First name', 'Last name', 'Company', 'Website', 'Position', 'Tags', 'Subscription', 'Consent source', 'Consent at'],
      all.map((r) => [r.email, r.first_name, r.last_name, r.company, r.website, r.position, (r.tags ?? []).join('; '), r.subscription_status, r.consent_source, r.consent_at]));
    return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="contacts.csv"', 'Cache-Control': 'no-store' } });
  });

  // ---------------- groups & segments ----------------
  const groupIn = z.object({ name: z.string().min(1).max(100), description: z.string().max(500).nullish(), is_segment: z.boolean().optional(),
    segment_filter: z.object({ tags: z.array(z.string().max(50)).max(20).optional(), company: z.string().max(200).optional(), status: z.enum(['subscribed', 'unsubscribed', 'cleaned', '']).optional() }).optional() });
  app.get('/api/groups', async (c) => c.json({ groups: unwrap(await c.get('db').from('contact_groups').select('*').order('name')) ?? [] }));
  app.post('/api/groups', async (c) => {
    const b = await body(c, groupIn);
    return c.json({ group: unwrap(await c.get('db').from('contact_groups').insert({ ...b, user_id: c.get('user').id }).select('*').single()) }, 201);
  });
  app.patch('/api/groups/:id', async (c) => {
    const b = await body(c, groupIn.partial());
    const row = unwrap(await c.get('db').from('contact_groups').update(b).eq('id', id(c)).select('*').maybeSingle());
    if (!row) throw new HttpError(404, 'Group not found');
    return c.json({ group: row });
  });
  app.delete('/api/groups/:id', async (c) => { unwrap(await c.get('db').from('contact_groups').delete().eq('id', id(c))); return c.json({ ok: true }); });
  app.get('/api/groups/:id/contacts', async (c) => c.json({ rows: unwrap(await c.get('db').rpc('group_contacts', { p_group: id(c) })) ?? [] }));
  app.post('/api/groups/:id/members', async (c) => {
    const b = await body(c, z.object({ contact_ids: z.array(uuid).min(1).max(5000) }));
    const g = id(c);
    unwrap(await c.get('db').from('contact_group_members').upsert(b.contact_ids.map((contact_id) => ({ group_id: g, contact_id })), { onConflict: 'group_id,contact_id', ignoreDuplicates: true }));
    return c.json({ ok: true, added: b.contact_ids.length });
  });
  app.delete('/api/groups/:id/members/:contactId', async (c) => {
    unwrap(await c.get('db').from('contact_group_members').delete().eq('group_id', id(c)).eq('contact_id', id(c, 'contactId')));
    return c.json({ ok: true });
  });

  // ---------------- templates ----------------
  const tplIn = z.object({ name: z.string().min(1).max(200), category: z.string().max(60).default('General'), subject: z.string().max(998).default(''), body_html: z.string().max(500_000).default(''), body_text: z.string().max(200_000).nullish() });
  app.get('/api/templates', async (c) => {
    const q = z.object({ search: z.string().max(200).optional(), category: z.string().max(60).optional() }).parse(c.req.query());
    let query = c.get('db').from('email_templates').select('*');
    if (q.search) { const s = safeLike(q.search); query = query.or(`name.ilike.%${s}%,subject.ilike.%${s}%`); }
    if (q.category) query = query.eq('category', q.category);
    return c.json({ templates: unwrap(await query.order('category').order('name')) ?? [] });
  });
  app.post('/api/templates', async (c) => {
    const b = await body(c, tplIn);
    return c.json({ template: unwrap(await c.get('db').from('email_templates').insert({ ...b, user_id: c.get('user').id }).select('*').single()) }, 201);
  });
  app.put('/api/templates/:id', async (c) => {
    const b = await body(c, tplIn.partial());
    const row = unwrap(await c.get('db').from('email_templates').update(b).eq('id', id(c)).select('*').maybeSingle());
    if (!row) throw new HttpError(404, 'Template not found');
    return c.json({ template: row });
  });
  app.post('/api/templates/:id/duplicate', async (c) => {
    const src = unwrap(await c.get('db').from('email_templates').select('*').eq('id', id(c)).maybeSingle());
    if (!src) throw new HttpError(404, 'Template not found');
    const { id: _i, created_at: _c, updated_at: _u, is_starter: _s, ...rest } = src;
    return c.json({ template: unwrap(await c.get('db').from('email_templates').insert({ ...rest, name: `${src.name} (copy)`.slice(0, 200), user_id: c.get('user').id }).select('*').single()) }, 201);
  });
  app.delete('/api/templates/:id', async (c) => { unwrap(await c.get('db').from('email_templates').delete().eq('id', id(c))); return c.json({ ok: true }); });

  // ---------------- suppression list ----------------
  app.get('/api/suppression', async (c) => {
    const q = pageQ.parse(c.req.query());
    let query = c.get('db').from('suppression_entries').select('*', { count: 'exact' });
    if (q.search) query = query.ilike('email', `%${safeLike(q.search)}%`);
    const r = await query.order('created_at', { ascending: false }).range(q.offset, q.offset + q.limit - 1);
    return c.json({ total: r.count ?? 0, rows: unwrap(r) ?? [] });
  });
  app.post('/api/suppression', async (c) => {
    const b = await body(c, z.object({ emails: z.array(z.string().max(320)).min(1).max(5000), reason: z.enum(['manual', 'complaint']).default('manual'), note: z.string().max(500).optional() }));
    const emails = [...new Set(b.emails.map(normalizeEmail))].filter(isValidEmail);
    if (!emails.length) throw new HttpError(400, 'No valid email addresses supplied');
    const uid = c.get('user').id;
    unwrap(await c.get('db').from('suppression_entries').upsert(emails.map((email) => ({ user_id: uid, email, reason: b.reason, source: 'manual', note: b.note ?? null })), { onConflict: 'user_id,email', ignoreDuplicates: true }));
    return c.json({ ok: true, added: emails.length });
  });
  app.delete('/api/suppression/:id', async (c) => { unwrap(await c.get('db').from('suppression_entries').delete().eq('id', id(c))); return c.json({ ok: true }); });

  // ---------------- activity, notifications, overview, analytics ----------------
  app.get('/api/activity', async (c) => {
    const q = pageQ.extend({ campaign_id: uuid.optional(), type: z.string().max(60).optional() }).parse(c.req.query());
    const db = c.get('db');
    let query = db.from('activity_logs').select('*', { count: 'exact' }).not('event_type', 'like', 'audit.%');
    if (q.campaign_id) query = query.eq('campaign_id', q.campaign_id);
    if (q.type) query = query.eq('event_type', q.type);
    const r = await query.order('created_at', { ascending: false }).range(q.offset, q.offset + q.limit - 1);
    const rows = (unwrap(r) ?? []) as any[];
    const ids = [...new Set(rows.map((x) => x.campaign_id).filter(Boolean))];
    const rids = [...new Set(rows.map((x) => x.recipient_id).filter(Boolean))];
    const [camps, recs] = await Promise.all([
      ids.length ? db.from('campaigns').select('id,name').in('id', ids) : { data: [], error: null },
      rids.length ? db.from('campaign_recipients').select('id,email').in('id', rids) : { data: [], error: null },
    ]);
    const cm = new Map((unwrap(camps) as any[]).map((x) => [x.id, x.name]));
    const rm = new Map((unwrap(recs) as any[]).map((x) => [x.id, x.email]));
    return c.json({ total: r.count ?? 0, rows: rows.map((x) => ({ ...x, campaign_name: cm.get(x.campaign_id) ?? null, recipient_email: rm.get(x.recipient_id) ?? null })) });
  });

  app.get('/api/notifications', async (c) => {
    const rows = unwrap(await c.get('db').from('notifications').select('*').order('created_at', { ascending: false }).limit(50)) ?? [];
    return c.json({ rows });
  });
  app.post('/api/notifications/read', async (c) => {
    const b = await body(c, z.object({ ids: z.array(uuid).max(200).optional() }).default({}));
    let q = c.get('db').from('notifications').update({ read_at: new Date().toISOString() }).is('read_at', null);
    if (b.ids?.length) q = q.in('id', b.ids);
    unwrap(await q);
    return c.json({ ok: true });
  });

  app.get('/api/overview', async (c) => c.json(unwrap(await c.get('db').rpc('overview_stats'))));
  app.get('/api/analytics', async (c) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(180).default(30) }).parse(c.req.query());
    return c.json(unwrap(await c.get('db').rpc('analytics_overview', { p_days: q.days })));
  });
}
