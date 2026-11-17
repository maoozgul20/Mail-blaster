export type CampaignStatus = 'draft' | 'scheduled' | 'queued' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';
export type FollowUpCondition = 'no_reply' | 'no_open' | 'no_click' | 'always';
export type RecipientFilter =
  | 'all' | 'pending' | 'queued' | 'sent' | 'opened' | 'not_opened' | 'clicked' | 'replied' | 'no_reply'
  | 'bounced' | 'unsubscribed' | 'failed' | 'skipped';

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

export type ScopeGroup = 'send' | 'read' | 'compose' | 'sheets';
export const SCOPE_GROUPS: Record<ScopeGroup, { scope: string; title: string; description: string }> = {
  send: { scope: GMAIL_SEND_SCOPE, title: 'Send email', description: 'Required. Lets MailBlaster submit the individual emails you create through your Gmail account. It cannot read your inbox.' },
  read: { scope: GMAIL_READ_SCOPE, title: 'Reply & bounce detection (optional)', description: 'Lets MailBlaster check the threads it started for replies and bounce notices so follow-ups stop automatically. Gmail "send" access alone cannot see replies. This is a restricted Google scope.' },
  compose: { scope: GMAIL_COMPOSE_SCOPE, title: 'Create drafts (optional)', description: 'Only needed for the "Create drafts, review, then send yourself" delivery mode.' },
  sheets: { scope: SHEETS_SCOPE, title: 'Google Sheets import (optional)', description: 'Read-only access to spreadsheets, used only when you import recipients from a Google Sheet.' },
};

export interface BusinessHours { enabled: boolean; start: string; end: string }

export interface CampaignSettings {
  daily_limit: number;
  min_interval_seconds: number;
  max_interval_seconds: number;
  timezone: string;
  business_hours: BusinessHours;
  weekdays: number[];
  track_opens: boolean;
  track_clicks: boolean;
  unsubscribe_link: boolean;
  reply_in_thread: boolean;
}

export interface FollowUpStepInput {
  enabled: boolean;
  delay_days: number;
  condition: FollowUpCondition;
  subject: string;
  body_html: string;
  reply_in_thread?: boolean;
}

export interface Attachment { name: string; path: string; size: number; type: string }

export interface CampaignInput {
  name: string;
  subject: string;
  body_html: string;
  body_text?: string | null;
  account_id?: string | null;
  template_id?: string | null;
  delivery_mode?: 'send' | 'draft';
  settings?: Partial<CampaignSettings>;
  attachments?: Attachment[];
  follow_ups?: { enabled: boolean; steps: FollowUpStepInput[] };
  recipients?: import('./recipients').RecipientInput[];
  start_at?: string | null;
  end_at?: string | null;
}

export interface CampaignStats {
  total: number; pending: number; queued: number; sent: number; drafted: number; opened: number; clicked: number;
  replied: number; bounced: number; unsubscribed: number; failed: number; skipped: number; follow_ups_sent: number;
}

export interface CampaignRow extends CampaignStats {
  id: string; name: string; status: CampaignStatus; subject: string; delivery_mode: string; start_at: string | null; end_at: string | null;
  started_at: string | null; completed_at: string | null; created_at: string; follow_ups_enabled: boolean; account_email: string | null;
}

export interface ConnectedAccount {
  id: string; email: string; display_name: string | null; status: 'active' | 'reauth_required' | 'disconnected' | 'error';
  scopes: string[]; daily_cap: number; max_concurrent: number; blocked_until: string | null; blocked_reason: string | null;
  last_error: string | null; next_send_at: string | null; created_at: string;
}
