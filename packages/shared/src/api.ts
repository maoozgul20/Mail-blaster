import type { CampaignInput, CampaignRow, CampaignStats, ConnectedAccount, RecipientFilter, ScopeGroup } from './types';
import type { RecipientInput } from './recipients';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: any) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number | null;
  user: { id: string; email: string };
}

export interface ApiClientOptions {
  baseUrl: string;
  getSession: () => Session | null | Promise<Session | null>;
  setSession: (s: Session | null) => void | Promise<void>;
  fetchImpl?: typeof fetch;
}

export interface UserSettings {
  timezone: string; daily_limit: number; min_interval_seconds: number; max_interval_seconds: number;
  business_hours: { enabled: boolean; start: string; end: string }; weekdays: number[]; track_opens: boolean; track_clicks: boolean;
  tracking_disclosure: string; unsubscribe_footer: boolean; unsubscribe_text: string; signature_html: string;
  default_followups: { enabled: boolean; delay_days: number; condition: string; subject: string; body_html: string }[];
  notifications: { campaign_completed: boolean; reply_received: boolean; failed_sending: boolean; campaign_paused: boolean };
}

export interface Me {
  user: { id: string; email: string; full_name: string | null };
  settings: UserSettings;
  accounts: ConnectedAccount[];
  unread_notifications: number;
  google_configured: boolean;
}

export interface Paged<T> { total: number; rows: T[] }

/** Typed wrapper over the MailBlaster Worker REST API. Handles bearer auth and a single transparent refresh on 401. */
export class ApiClient {
  private refreshing: Promise<Session | null> | null = null;
  constructor(private o: ApiClientOptions) {}

  get baseUrl() { return this.o.baseUrl.replace(/\/$/, ''); }
  private f(...a: Parameters<typeof fetch>) { return (this.o.fetchImpl ?? fetch)(...a); }

  private async doRefresh(): Promise<Session | null> {
    const s = await this.o.getSession();
    if (!s?.refresh_token) return null;
    try {
      const res = await this.f(`${this.baseUrl}/api/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: s.refresh_token }) });
      if (!res.ok) { await this.o.setSession(null); return null; }
      const next = ((await res.json()) as { session: Session }).session;
      await this.o.setSession(next);
      return next;
    } catch { return null; }
  }
  private refresh() { return (this.refreshing ??= this.doRefresh().finally(() => { this.refreshing = null; })); }

  async request<T = any>(method: string, path: string, body?: unknown, opts: { auth?: boolean; form?: FormData; raw?: boolean } = {}): Promise<T> {
    const auth = opts.auth !== false;
    const go = async (session: Session | null) => {
      const headers: Record<string, string> = {};
      if (auth && session) headers.Authorization = `Bearer ${session.access_token}`;
      let payload: BodyInit | undefined;
      if (opts.form) payload = opts.form;
      else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
      try {
        return await this.f(`${this.baseUrl}${path}`, { method, headers, body: payload });
      } catch {
        throw new ApiError(0, 'Cannot reach the MailBlaster API. Check your connection and the API URL.');
      }
    };
    let session = auth ? await this.o.getSession() : null;
    if (auth && !session) throw new ApiError(401, 'Not signed in');
    let res = await go(session);
    if (res.status === 401 && auth) {
      session = await this.refresh();
      if (!session) { await this.o.setSession(null); throw new ApiError(401, 'Session expired, please sign in again'); }
      res = await go(session);
    }
    if (opts.raw) {
      if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => 'Request failed'));
      return res as unknown as T;
    }
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) throw new ApiError(res.status, json?.error ?? `Request failed (${res.status})`, json);
    return json as T;
  }

  private q(params: Record<string, unknown>) {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
    const str = s.toString();
    return str ? `?${str}` : '';
  }

  // ---- auth ----
  async login(email: string, password: string) {
    const r = await this.request<{ session: Session }>('POST', '/api/auth/login', { email, password }, { auth: false });
    await this.o.setSession(r.session);
    return r.session;
  }
  async signup(email: string, password: string, full_name?: string) {
    const r = await this.request<{ session: Session | null; needs_confirmation: boolean }>('POST', '/api/auth/signup', { email, password, full_name }, { auth: false });
    if (r.session) await this.o.setSession(r.session);
    return r;
  }
  async logout() { await this.o.setSession(null); }
  signOutEverywhere() { return this.request('POST', '/api/auth/signout-all'); }

  // ---- account/settings ----
  me() { return this.request<Me>('GET', '/api/me'); }
  updateSettings(patch: Partial<UserSettings>) { return this.request<{ settings: UserSettings }>('PUT', '/api/settings', patch); }
  updateProfile(full_name: string) { return this.request('PUT', '/api/profile', { full_name }); }
  accounts() { return this.request<{ accounts: ConnectedAccount[] }>('GET', '/api/accounts'); }
  startOAuth(groups: ScopeGroup[], return_to: 'dashboard' | 'extension' = 'dashboard', login_hint?: string) {
    return this.request<{ url: string; scopes: string[] }>('POST', '/api/oauth/google/start', { groups, return_to, login_hint });
  }
  disconnectAccount(id: string) { return this.request('DELETE', `/api/accounts/${id}`); }
  updateAccount(id: string, patch: { max_concurrent: number }) { return this.request('PATCH', `/api/accounts/${id}`, patch); }
  deleteAccount() { return this.request('DELETE', '/api/account', { confirm: 'DELETE' }); }
  exportData() { return this.request<Response>('GET', '/api/account/export', undefined, { raw: true }); }

  // ---- campaigns ----
  listCampaigns(p: { status?: string; search?: string; limit?: number; offset?: number } = {}) { return this.request<Paged<CampaignRow>>('GET', `/api/campaigns${this.q(p)}`); }
  createCampaign(c: CampaignInput & { launch?: boolean }) { return this.request<{ id: string; launched: boolean; inserted: number; invalid: number; duplicates: number; suppressed: number; error?: string }>('POST', '/api/campaigns', c); }
  getCampaign(id: string) { return this.request<any>('GET', `/api/campaigns/${id}`); }
  updateCampaign(id: string, c: Partial<CampaignInput>) { return this.request<any>('PUT', `/api/campaigns/${id}`, c); }
  startCampaign(id: string, start_at?: string | null) { return this.request<any>('POST', `/api/campaigns/${id}/start`, { start_at: start_at ?? null }); }
  campaignAction(id: string, action: 'pause' | 'resume' | 'cancel' | 'duplicate') { return this.request<any>('POST', `/api/campaigns/${id}/${action}`); }
  deleteCampaign(id: string) { return this.request('DELETE', `/api/campaigns/${id}`); }
  setFollowUps(id: string, enabled: boolean) { return this.request('POST', `/api/campaigns/${id}/followups`, { enabled }); }
  retryFailed(id: string) { return this.request<{ requeued: number }>('POST', `/api/campaigns/${id}/retry-failed`); }
  campaignRecipients(id: string, p: { filter?: RecipientFilter; search?: string; sort?: string; dir?: 'asc' | 'desc'; limit?: number; offset?: number }) {
    return this.request<Paged<any>>('GET', `/api/campaigns/${id}/recipients${this.q(p)}`);
  }
  async downloadCsv(path: string): Promise<Blob> { return (await this.request<Response>('GET', path, undefined, { raw: true })).blob(); }
  recipientDetail(id: string) { return this.request<any>('GET', `/api/recipients/${id}`); }
  resolveJob(id: string, outcome: 'sent' | 'retry') { return this.request('POST', `/api/jobs/${id}/resolve`, { outcome }); }
  checkSuppressed(emails: string[]) { return this.request<{ suppressed: string[] }>('POST', '/api/check-suppressed', { emails }); }

  // ---- data ----
  overview() { return this.request<any>('GET', '/api/overview'); }
  analytics(days = 30) { return this.request<any>('GET', `/api/analytics?days=${days}`); }
  activity(p: { limit?: number; offset?: number; type?: string; campaign_id?: string } = {}) { return this.request<Paged<any>>('GET', `/api/activity${this.q(p)}`); }
  notifications() { return this.request<{ rows: any[] }>('GET', '/api/notifications'); }
  markNotificationsRead(ids?: string[]) { return this.request('POST', '/api/notifications/read', { ids }); }

  contacts(p: { search?: string; tag?: string; status?: string; group?: string; limit?: number; offset?: number } = {}) { return this.request<Paged<any>>('GET', `/api/contacts${this.q(p)}`); }
  createContact(c: Record<string, unknown>) { return this.request<{ contact: any }>('POST', '/api/contacts', c); }
  importContacts(rows: RecipientInput[], group_id?: string | null, consent_source = 'import') {
    return this.request<{ inserted: number; updated: number; invalid: number; duplicates: number }>('POST', '/api/contacts/import', { rows, group_id: group_id ?? null, consent_source });
  }
  updateContact(id: string, c: Record<string, unknown>) { return this.request('PATCH', `/api/contacts/${id}`, c); }
  deleteContacts(ids: string[]) { return this.request('POST', '/api/contacts/bulk-delete', { ids }); }
  groups() { return this.request<{ groups: any[] }>('GET', '/api/groups'); }
  createGroup(g: Record<string, unknown>) { return this.request<{ group: any }>('POST', '/api/groups', g); }
  deleteGroup(id: string) { return this.request('DELETE', `/api/groups/${id}`); }
  groupContacts(id: string) { return this.request<{ rows: any[] }>('GET', `/api/groups/${id}/contacts`); }
  addGroupMembers(id: string, contact_ids: string[]) { return this.request('POST', `/api/groups/${id}/members`, { contact_ids }); }

  templates(p: { search?: string; category?: string } = {}) { return this.request<{ templates: any[] }>('GET', `/api/templates${this.q(p)}`); }
  createTemplate(t: Record<string, unknown>) { return this.request<{ template: any }>('POST', '/api/templates', t); }
  updateTemplate(id: string, t: Record<string, unknown>) { return this.request<{ template: any }>('PUT', `/api/templates/${id}`, t); }
  duplicateTemplate(id: string) { return this.request<{ template: any }>('POST', `/api/templates/${id}/duplicate`); }
  deleteTemplate(id: string) { return this.request('DELETE', `/api/templates/${id}`); }

  suppression(p: { search?: string; limit?: number; offset?: number } = {}) { return this.request<Paged<any>>('GET', `/api/suppression${this.q(p)}`); }
  addSuppression(emails: string[], note?: string) { return this.request('POST', '/api/suppression', { emails, note }); }
  removeSuppression(id: string) { return this.request('DELETE', `/api/suppression/${id}`); }

  sheetsInfo(spreadsheet: string, account_id?: string) { return this.request<{ spreadsheetId: string; title: string; sheets: { title: string; rows: number; cols: number }[] }>('POST', '/api/sheets/info', { spreadsheet, account_id }); }
  sheetsValues(spreadsheetId: string, sheet: string, account_id?: string) { return this.request<{ headers: string[]; rows: Record<string, string>[]; truncated: boolean }>('POST', '/api/sheets/values', { spreadsheetId, sheet, account_id }); }
  async uploadAttachment(file: File) {
    const form = new FormData();
    form.set('file', file);
    return this.request<{ attachment: { name: string; path: string; size: number; type: string } }>('POST', '/api/attachments', undefined, { form });
  }
  deleteAttachment(path: string) { return this.request('DELETE', `/api/attachments?path=${encodeURIComponent(path)}`); }
}

export type { CampaignStats };
