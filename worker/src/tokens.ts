import { decryptSecret, encryptSecret } from '@mailblaster/shared';
import type { Env } from './env';
import type { Store } from './store';
import { GoogleAuthError, refreshAccessToken } from './google';

interface TokenRow {
  account_id: string; email: string; user_id: string; status: string; scopes: string[];
  refresh_token_enc: string | null; access_token_enc: string | null; access_expires_at: string | null;
}

/** Thrown when the account cannot send until the user reconnects (revoked, expired in Google "testing" mode, disconnected). */
export class ReauthRequired extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReauthRequired';
  }
}

/**
 * Returns a valid access token for the account, refreshing (and re-encrypting) when needed.
 * Google apps in "Testing" publishing status issue refresh tokens that expire after 7 days -> invalid_grant -> ReauthRequired.
 */
export async function getAccessToken(
  store: Store, env: Pick<Env, 'ENCRYPTION_KEY' | 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET' | 'GOOGLE_REDIRECT_URI'>,
  accountId: string, opts: { force?: boolean; now?: Date } = {},
): Promise<string> {
  const row = await store.rpc<TokenRow | null>('wk_get_tokens', { p_account: accountId });
  if (!row) throw new ReauthRequired('account not found');
  if (row.status !== 'active') throw new ReauthRequired(`account is ${row.status}`);
  if (!row.refresh_token_enc) throw new ReauthRequired('no refresh token stored');
  const now = (opts.now ?? new Date()).getTime();
  if (!opts.force && row.access_token_enc && row.access_expires_at && new Date(row.access_expires_at).getTime() - now > 120_000) {
    try {
      return await decryptSecret(row.access_token_enc, env.ENCRYPTION_KEY);
    } catch { /* fall through and refresh */ }
  }
  let refresh: string;
  try {
    refresh = await decryptSecret(row.refresh_token_enc, env.ENCRYPTION_KEY);
  } catch {
    throw new ReauthRequired('stored token cannot be decrypted (ENCRYPTION_KEY changed?)');
  }
  try {
    const t = await refreshAccessToken(env as Env, refresh);
    await store.rpc('wk_store_access_token', {
      p_account: accountId, p_access_enc: await encryptSecret(t.access_token, env.ENCRYPTION_KEY),
      p_expires: new Date(now + t.expires_in * 1000).toISOString(),
    });
    return t.access_token;
  } catch (e) {
    if (e instanceof GoogleAuthError) throw new ReauthRequired(`Google rejected the refresh token (${e.code}). Reconnect the account.`);
    throw e;
  }
}
