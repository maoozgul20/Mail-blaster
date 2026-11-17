import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app';
import { HttpError, body, toCsv, unwrap } from '../http';

const uuid = z.string().uuid();
const recipient = z.object({
  email: z.string().max(320),
  first_name: z.string().max(200).optional(), last_name: z.string().max(200).optional(), company: z.string().max(300).optional(),
  website: z.string().max(300).optional(), position: z.string().max(300).optional(),
  fields: z.record(z.string(), z.string().max(2000)).optional(), contact_id: uuid.optional(),
});
const step = z.object({
  enabled: z.boolean().default(true), delay_days: z.number().min(0.001).max(365).optional(), delay_minutes: z.number().int().min(1).max(525_600).optional(),
  condition: z.enum(['no_reply', 'no_open', 'no_click', 'always']).default('no_reply'),
  subject: z.string().max(998).default(''), body_html: z.string().max(200_000).default(''), reply_in_thread: z.boolean().optional(),
});
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const iso = z.string().datetime({ offset: true }).nullable();

export const campaignSchema = z.object({
  name: z.string().min(1).max(200),
  subject: z.string().max(998).optional(),
  body_html: z.string().max(500_000).optional(),
  body_text: z.string().max(200_000).nullable().optional(),
  account_id: uuid.nullable().optional(),
  template_id: uuid.nullable().optional(),
  delivery_mode: z.enum(['send', 'draft']).optional(),
  settings: z.object({
    daily_limit: z.number().int().min(1).max(2000), min_interval_seconds: z.number().int().min(0).max(86_400), max_interval_seconds: z.number().int().min(0).max(86_400),
    timezone: z.string().max(64), business_hours: z.object({ enabled: z.boolean(), start: hhmm, end: hhmm }), weekdays: z.array(z.number().int().min(1).max(7)).min(1),
    track_opens: z.boolean(), track_clicks: z.boolean(), unsubscribe_link: z.boolean(), reply_in_thread: z.boolean(),
  }).partial().optional(),
  attachments: z.array(z.object({ name: z.string().max(200), path: z.string().max(500), size: z.number().int().min(0).max(2_097_152), type: z.string().max(100) })).max(3).optional(),
  follow_ups: z.object({ enabled: z.boolean(), steps: z.array(step).max(10) }).optional(),
  recipients: z.array(recipient).max(5000).optional(),
  start_at: iso.optional(),
  end_at: iso.optional(),
});

const FILTERS = ['all', 'pending', 'queued', 'sent', 'opened', 'not_opened', 'clicked', 'replied', 'no_reply', 'bounced', 'unsubscribed', 'failed', 'skipped'] as const;
const listQuery = z.object({
  filter: z.enum(FILTERS).default('all'), search: z.string().max(200).optional(), sort: z.string().max(40).default('created_at'),
  dir: z.enum(['asc', 'desc']).default('asc'), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export function campaignRoutes(app: Hono<AppEnv>) {
  const rpc = (c: any, fn: string, args: Record<string, unknown> = {}) => c.get('db').rpc(fn, args);
  const id = (c: any) => { const p = uuid.safeParse(c.req.param('id')); if (!p.success) throw new HttpError(400, 'Invalid id'); return p.data; };

  app.get('/api/campaigns', async (c) => {
    const q = z.object({ status: z.string().max(20).optional(), search: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }).parse(c.req.query());
    return c.json(unwrap(await rpc(c, 'list_campaigns', { p_status: q.status ?? null, p_search: q.search ?? null, p_limit: q.limit, p_offset: q.offset })));
  });

  app.post('/api/campaigns', async (c) => {
    const { launch, ...rest } = await body(c, campaignSchema.extend({ launch: z.boolean().optional() }));
    const saved = unwrap(await rpc(c, 'save_campaign', { p_id: null, p: rest })) as { id: string };
    if (!launch) return c.json({ ...saved, launched: false }, 201);
    const started = await rpc(c, 'start_campaign', { p_id: saved.id, p_start_at: rest.start_at ?? null });
    if (started.error) return c.json({ ...saved, launched: false, error: started.error.message }, 400);
    return c.json({ ...saved, launched: true, start: started.data }, 201);
  });

  app.get('/api/campaigns/:id', async (c) => {
    const data = unwrap(await rpc(c, 'get_campaign', { p_id: id(c) }));
    if (!data) throw new HttpError(404, 'Campaign not found');
    return c.json(data);
  });

  app.put('/api/campaigns/:id', async (c) => {
    const b = await body(c, campaignSchema.partial());
    return c.json(unwrap(await rpc(c, 'save_campaign', { p_id: id(c), p: b })));
  });

  app.post('/api/campaigns/:id/start', async (c) => {
    const b = await body(c, z.object({ start_at: iso.optional() }).default({}));
    return c.json(unwrap(await rpc(c, 'start_campaign', { p_id: id(c), p_start_at: b.start_at ?? null })));
  });
  for (const action of ['pause', 'resume', 'cancel'] as const) {
    app.post(`/api/campaigns/:id/${action}`, async (c) => c.json(unwrap(await rpc(c, `${action}_campaign`, { p_id: id(c) }))));
  }
  app.post('/api/campaigns/:id/duplicate', async (c) => c.json(unwrap(await rpc(c, 'duplicate_campaign', { p_id: id(c) })), 201));
  app.delete('/api/campaigns/:id', async (c) => { unwrap(await rpc(c, 'delete_campaign', { p_id: id(c) })); return c.json({ ok: true }); });
  app.post('/api/campaigns/:id/followups', async (c) => {
    const b = await body(c, z.object({ enabled: z.boolean() }));
    return c.json(unwrap(await rpc(c, 'set_followups_enabled', { p_id: id(c), p_enabled: b.enabled })));
  });
  app.post('/api/campaigns/:id/retry-failed', async (c) => c.json({ requeued: unwrap(await rpc(c, 'retry_failed_jobs', { p_id: id(c) })) }));

  app.get('/api/campaigns/:id/recipients', async (c) => {
    const q = listQuery.parse(c.req.query());
    return c.json(unwrap(await rpc(c, 'list_campaign_recipients', { p_campaign: id(c), p_filter: q.filter, p_search: q.search ?? null, p_sort: q.sort, p_dir: q.dir, p_limit: q.limit, p_offset: q.offset })));
  });

  app.get('/api/campaigns/:id/export.csv', async (c) => {
    const q = listQuery.partial().parse(c.req.query());
    const rows: any[] = [];
    for (let off = 0; off < 5000; off += 1000) {
      const page = unwrap(await rpc(c, 'list_campaign_recipients', { p_campaign: id(c), p_filter: q.filter ?? 'all', p_search: q.search ?? null, p_sort: 'created_at', p_dir: 'asc', p_limit: 1000, p_offset: off })) as { rows: any[] };
      rows.push(...page.rows);
      if (page.rows.length < 1000) break;
    }
    const csv = toCsv(
      ['Email', 'First name', 'Last name', 'Company', 'Status', 'Sent at', 'Opens', 'Last opened', 'Clicks', 'Replied at', 'Reply preview', 'Follow-ups sent', 'Failure reason', 'Skip reason'],
      rows.map((r) => [r.email, r.first_name, r.last_name, r.company, r.status, r.sent_at, r.open_count, r.last_opened_at, r.click_count, r.replied_at, r.reply_preview, r.follow_ups_sent, r.failure_reason, r.skip_reason]),
    );
    return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="campaign-recipients.csv"', 'Cache-Control': 'no-store' } });
  });

  app.get('/api/recipients/:id', async (c) => {
    const data = unwrap(await rpc(c, 'recipient_detail', { p_recipient: id(c) }));
    if (!data) throw new HttpError(404, 'Recipient not found');
    return c.json(data);
  });

  app.post('/api/jobs/:id/resolve', async (c) => {
    const b = await body(c, z.object({ outcome: z.enum(['sent', 'retry']) }));
    return c.json(unwrap(await rpc(c, 'resolve_job', { p_job: id(c), p_outcome: b.outcome })));
  });

  app.post('/api/check-suppressed', async (c) => {
    const b = await body(c, z.object({ emails: z.array(z.string().max(320)).max(5000) }));
    return c.json({ suppressed: unwrap(await rpc(c, 'check_suppressed', { p_emails: b.emails })) ?? [] });
  });
}
