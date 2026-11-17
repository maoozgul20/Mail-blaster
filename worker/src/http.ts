import type { Context } from 'hono';
import type { ZodTypeAny, z } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Translate PostgREST / PostgreSQL errors into safe HTTP errors. Messages raised by our own SQL functions (P0001) are user-facing. */
export function unwrap<T = any>(res: { data: T | null; error: any; count?: number | null }): T {
  if (!res.error) return res.data as T;
  const e = res.error;
  const code = String(e.code ?? '');
  const msg = String(e.message ?? 'database error');
  if (code === '28000' || /not authenticated/i.test(msg)) throw new HttpError(401, 'Not authenticated');
  if (code === '42501') throw new HttpError(403, 'Not allowed');
  if (code === 'P0001') throw new HttpError(400, msg);
  if (code === '23505') throw new HttpError(409, 'That record already exists');
  if (['23503', '23514', '22P02', '22007', '22003', '23502', '22001'].includes(code)) throw new HttpError(400, 'Invalid data');
  if (code === 'PGRST116') throw new HttpError(404, 'Not found');
  console.error('database error', code, msg);
  throw new HttpError(500, 'Database error');
}

export async function body<S extends ZodTypeAny>(c: Context, schema: S): Promise<z.infer<S>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
  const r = schema.safeParse(json);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new HttpError(400, `${i.path.join('.') || 'body'}: ${i.message}`);
  }
  return r.data;
}

export const clientIp = (c: Context) => c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

/** Spreadsheet formula injection guard for CSV exports. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = (header: string[], rows: unknown[][]) => [header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
