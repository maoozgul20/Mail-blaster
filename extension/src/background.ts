import { ApiClient, ApiError } from '@mailblaster/shared';
import { getConfig, getSession, setSession, type BgRequest, type BgResponse } from './chrome-api';

const ALLOWED = new Set([
  'login', 'signup', 'logout', 'me', 'accounts', 'listCampaigns', 'createCampaign', 'getCampaign', 'updateCampaign', 'startCampaign', 'campaignAction',
  'templates', 'createTemplate', 'testEmail', 'checkSuppressed', 'sheetsInfo', 'sheetsValues', 'groups', 'groupContacts', 'contacts', 'overview',
]);

async function handle(req: BgRequest): Promise<BgResponse> {
  try {
    if (req.type === 'openTab') {
      const cfg = await getConfig();
      const url = new URL(req.url, cfg.dashboardUrl);
      if (url.origin !== new URL(cfg.dashboardUrl).origin) throw new ApiError(400, 'Refusing to open a URL outside the dashboard');
      await chrome.tabs.create({ url: url.toString() });
      return { ok: true, data: true };
    }
    if (req.type === 'status') {
      const [cfg, session] = await Promise.all([getConfig(), getSession()]);
      return { ok: true, data: { config: cfg, signedIn: !!session, email: session?.user.email ?? null } };
    }
    if (req.type === 'call') {
      if (!ALLOWED.has(req.method)) throw new ApiError(400, `Method not allowed: ${req.method}`);
      const cfg = await getConfig();
      const api = new ApiClient({ baseUrl: cfg.apiBaseUrl, getSession, setSession });
      const fn = (api as any)[req.method] as (...a: unknown[]) => Promise<unknown>;
      return { ok: true, data: await fn.apply(api, req.args) };
    }
    throw new ApiError(400, 'Unknown request');
  } catch (e) {
    const err = e as ApiError;
    return { ok: false, status: err.status ?? 0, error: err.message ?? 'Unexpected error' };
  }
}

chrome.runtime.onMessage.addListener((req: BgRequest, sender, sendResponse) => {
  // only our own extension pages and content scripts may use the API bridge
  if (sender.id !== chrome.runtime.id) return false;
  handle(req).then(sendResponse);
  return true; // async response
});

chrome.runtime.onInstalled.addListener(async (d) => {
  if (d.reason === 'install') chrome.runtime.openOptionsPage();
});
