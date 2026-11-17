/** Shape returned by public.wk_claim_jobs(). */
export interface ClaimedJob {
  job: { id: string; step_number: number; attempts: number; idempotency_key: string; worker: string; claimed_at: string; user_id: string };
  account: { id: string; email: string; display_name: string | null; scopes: string[] };
  campaign: {
    id: string; name: string; subject: string; body_html: string; body_text: string | null; delivery_mode: 'send' | 'draft';
    settings: Record<string, unknown>; attachments: { name: string; path: string; size: number; type: string }[];
  };
  recipient: {
    id: string; email: string; first_name: string | null; last_name: string | null; company: string | null; website: string | null;
    position: string | null; fields: Record<string, unknown>; token: string;
  };
  step: { subject: string; body_html: string; body_text: string | null; reply_in_thread: boolean } | null;
  thread: { thread_id: string; rfc_message_id: string; subject: string } | null;
  user_settings: {
    track_opens: boolean; track_clicks: boolean; unsubscribe_footer: boolean; unsubscribe_text: string; signature_html: string; tracking_disclosure: string;
  };
}
