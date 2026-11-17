import { ApiClient, ApiError, type Session } from '@mailblaster/shared';

declare const __API_BASE_URL__: string;
declare const __DASHBOARD_URL__: string;

export interface Config { apiBaseUrl: string; dashboardUrl: string }
export const DEFAULTS: Config = { apiBaseUrl: __API_BASE_URL__, dashboardUrl: __DASHBOARD_URL__ };

/** Non-sensitive preferences live in chrome.storage.sync; the session (tokens) stays in chrome.storage.local on this device only. */
export async function getConfig(): Promise<Config> {
  const s = await chrome.storage.sync.get(['apiBaseUrl', 'dashboardUrl']);
  return { apiBaseUrl: (s.apiBaseUrl as string) || DEFAULTS.apiBaseUrl, dashboardUrl: (s.dashboardUrl as string) || DEFAULTS.dashboardUrl };
}
export const setConfig = (c: Partial<Config>) => chrome.storage.sync.set(c);
export const getSession = async (): Promise<Session | null> => ((await chrome.storage.local.get('session')).session as Session | undefined) ?? null;
export const setSession = async (s: Session | null) => { s ? await chrome.storage.local.set({ session: s }) : await chrome.storage.local.remove('session'); };

export async function makeApi(): Promise<ApiClient> {
  const cfg = await getConfig();
  return new ApiClient({ baseUrl: cfg.apiBaseUrl, getSession, setSession });
}

export { ApiError };

/** Messaging contract between content script / popup / options and the background service worker. */
export type BgRequest =
  | { type: 'call'; method: string; args: unknown[] }
  | { type: 'openTab'; url: string }
  | { type: 'status' };
export type BgResponse<T = unknown> = { ok: true; data: T } | { ok: false; status: number; error: string };

export async function bg<T = any>(req: BgRequest): Promise<T> {
  const res: BgResponse<T> = await chrome.runtime.sendMessage(req);
  if (!res) throw new ApiError(0, 'The MailBlaster extension is not responding. Reload the page.');
  if (!res.ok) throw new ApiError(res.status, res.error);
  return res.data;
}

/** Calls any ApiClient method through the background worker (content scripts cannot call the API directly because of CORS). */
export const call = <T = any>(method: string, ...args: unknown[]) => {
  // chrome.runtime messages are JSON: a trailing `undefined` argument would arrive as `null`, so drop trailing undefined values
  const a = [...args];
  while (a.length && a[a.length - 1] === undefined) a.pop();
  return bg<T>({ type: 'call', method, args: a });
};
