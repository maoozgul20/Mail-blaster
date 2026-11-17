import { SCOPE_GROUPS, type ScopeGroup } from '@mailblaster/shared';
import type { Env } from './env';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

/** invalid_grant etc.: the refresh token is expired/revoked, the user must reconnect. */
export class GoogleAuthError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}
/** Anything else (Google 5xx / network): safe to retry later. */
export class GoogleTransientError extends Error {}

export function scopesForGroups(groups: ScopeGroup[]): string[] {
  const set = new Set<string>([SCOPE_GROUPS.send.scope]); // sending permission is always requested first
  for (const g of groups) if (SCOPE_GROUPS[g]) set.add(SCOPE_GROUPS[g].scope);
  return [...set];
}

export function buildAuthUrl(env: Env, opts: { scopes: string[]; state: string; loginHint?: string }): string {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: ['openid', 'email', 'profile', ...opts.scopes].join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true', // incremental authorization: asking for reply-detection later keeps send access
    prompt: 'consent', // guarantees a refresh token on every (re)authorization
    state: opts.state,
  });
  if (opts.loginHint) p.set('login_hint', opts.loginHint);
  return `${GOOGLE_AUTH_URL}?${p}`;
}

interface TokenResponse { access_token: string; refresh_token?: string; expires_in: number; scope?: string; id_token?: string }

async function tokenRequest(env: Env, body: Record<string, string>): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...body }),
    });
  } catch (e) {
    throw new GoogleTransientError((e as Error).message);
  }
  const j = (await res.json().catch(() => ({}))) as any;
  if (res.ok) return j as TokenResponse;
  if (res.status >= 500 || res.status === 429) throw new GoogleTransientError(`Google token endpoint ${res.status}`);
  throw new GoogleAuthError(j.error_description || j.error || `token error ${res.status}`, j.error || 'invalid_request');
}

export const exchangeCode = (env: Env, code: string) =>
  tokenRequest(env, { grant_type: 'authorization_code', code, redirect_uri: env.GOOGLE_REDIRECT_URI });

export const refreshAccessToken = (env: Env, refreshToken: string) =>
  tokenRequest(env, { grant_type: 'refresh_token', refresh_token: refreshToken });

export async function fetchUserInfo(accessToken: string): Promise<{ email: string; name?: string; email_verified?: boolean }> {
  const res = await fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new GoogleTransientError(`userinfo ${res.status}`);
  return (await res.json()) as any;
}

export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch(GOOGLE_REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) });
  } catch { /* best effort */ }
}

// ---- Google Sheets (read-only; used only when the user imports from a sheet) ----
export function parseSpreadsheetId(input: string): string | null {
  const m = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(input.trim()) ? input.trim() : null;
}

export async function sheetsInfo(token: string, id: string): Promise<{ title: string; sheets: { title: string; rows: number; cols: number }[] }> {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=properties.title,sheets.properties`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(res.status === 404 ? 'Spreadsheet not found or not shared with this Google account' : res.status === 403 ? 'Google refused access to this spreadsheet (check sharing and that the Sheets permission was granted)' : `Sheets API error ${res.status}`);
  const j = (await res.json()) as any;
  return {
    title: j.properties?.title ?? '',
    sheets: (j.sheets ?? []).map((s: any) => ({ title: s.properties.title, rows: s.properties.gridProperties?.rowCount ?? 0, cols: s.properties.gridProperties?.columnCount ?? 0 })),
  };
}

export async function sheetsValues(token: string, id: string, sheet: string, maxRows = 5001): Promise<string[][]> {
  const range = encodeURIComponent(`'${sheet.replace(/'/g, "''")}'!A1:ZZ${maxRows}`);
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}?majorDimension=ROWS`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets API error ${res.status}`);
  return (((await res.json()) as any).values ?? []) as string[][];
}
