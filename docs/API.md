# REST API reference

Base URL: your Worker (`https://mailblaster-api.<subdomain>.workers.dev`). JSON in/out. Errors: `{"error": "message"}` with a 4xx/5xx status.
Auth: `Authorization: Bearer <access_token>` from `/api/auth/login` (a Supabase JWT). Browser CORS is limited to `FRONTEND_URL` (+ `ALLOWED_ORIGINS`) and Chrome extensions.
Row Level Security means every route only ever sees the caller's own data. Limits: 600 requests/min/user per isolate; auth endpoints are additionally rate-limited in PostgreSQL.

## Auth

| Method & path | Body | Notes |
|---|---|---|
| `POST /api/auth/signup` | `{email, password(8–72), full_name?}` | 403 if `ALLOW_SIGNUPS=false`. Returns `{user, session\|null, needs_confirmation}` |
| `POST /api/auth/login` | `{email, password}` | `{session:{access_token, refresh_token, expires_at, user}}`; 20/5 min per IP, 10/5 min per email |
| `POST /api/auth/refresh` | `{refresh_token}` | new session |
| `POST /api/auth/signout-all` | – | revokes all sessions of the user |

## Account, settings, Gmail

| | | |
|---|---|---|
| `GET /api/me` | | user, settings, connected accounts (no tokens), unread notifications, `google_configured` |
| `PUT /api/settings` | partial of `timezone, daily_limit, min/max_interval_seconds, business_hours{enabled,start,end}, weekdays[1-7], track_opens, track_clicks, tracking_disclosure, unsubscribe_footer, unsubscribe_text, signature_html, default_followups[], notifications{}` | strict validation |
| `PUT /api/profile` | `{full_name}` | |
| `GET /api/accounts` | | |
| `POST /api/oauth/google/start` | `{groups:["send","read","compose","sheets"], return_to, login_hint?}` | returns `{url}`; send is always included |
| `GET /oauth/google/callback` | (Google redirect) | public; signed `state`; stores **encrypted** tokens; redirects to the dashboard |
| `PATCH /api/accounts/:id` | `{max_concurrent 1–5}` | |
| `DELETE /api/accounts/:id` | | revokes at Google, deletes tokens, pauses its campaigns |
| `GET /api/account/export` | | full JSON export, no tokens |
| `DELETE /api/account` | `{confirm:"DELETE"}` | deletes everything + revokes Google |
| `POST /api/sheets/info` / `/values` | `{spreadsheet}` / `{spreadsheetId, sheet}` | needs the optional Sheets permission |
| `POST /api/attachments`, `DELETE /api/attachments?path=` | multipart `file` | ≤2 MB; pdf/png/jpg/gif/txt/csv/docx/xlsx/pptx |

## Campaigns

| | | |
|---|---|---|
| `GET /api/campaigns?status&search&limit&offset` | | `{total, rows[{…stats}]}` |
| `POST /api/campaigns` | campaign + `launch?` + `start_at?` | creates a draft (`201`) and optionally starts it. Response has `inserted, invalid, duplicates, suppressed`. If the start fails: `400` with `{id, launched:false, error}` and the draft kept |
| `GET /api/campaigns/:id` | | campaign, `stats`, `follow_ups`, `jobs{queued,followups_queued,ambiguous,failed,next_run_at}`, account |
| `PUT /api/campaigns/:id` | partial campaign | drafts only; `recipients` replaces the list |
| `POST /api/campaigns/:id/start` | `{start_at?}` | `scheduled` if in the future |
| `POST /api/campaigns/:id/pause\|resume\|cancel\|duplicate` | | |
| `DELETE /api/campaigns/:id` | | draft, completed, cancelled or failed campaigns (cancel a running one first); removes its recipients, history and pending follow-ups, keeps suppression entries |
| `POST /api/campaigns/:id/followups` | `{enabled}` | disabling cancels queued follow-ups |
| `POST /api/campaigns/:id/retry-failed` | | re-queues `transient_exhausted` jobs |
| `GET /api/campaigns/:id/recipients?filter&search&sort&dir&limit&offset` | | filters: `all pending queued sent opened not_opened clicked replied no_reply bounced unsubscribed failed skipped` |
| `GET /api/campaigns/:id/export.csv?filter` | | formula-injection-safe CSV |
| `GET /api/recipients/:id` | | messages, jobs, events, replies, bounces, timeline |
| `POST /api/jobs/:id/resolve` | `{outcome:"sent"\|"retry"}` | for `ambiguous` jobs |
| `POST /api/check-suppressed` | `{emails[]}` | |

Campaign body: `{name, subject, body_html, body_text?, account_id?, template_id?, delivery_mode:"send"|"draft", settings:{daily_limit, min_interval_seconds, max_interval_seconds, timezone, business_hours, weekdays, track_opens, track_clicks, unsubscribe_link, reply_in_thread}, attachments[], follow_ups:{enabled, steps:[{enabled, delay_days|delay_minutes, condition:"no_reply"|"no_open"|"no_click"|"always", subject, body_html, reply_in_thread?}]}, recipients:[{email, first_name?, last_name?, company?, website?, position?, fields?{}}], start_at?, end_at?}` (≤ 5000 recipients, ≤ 10 stages).

## Data

`GET/POST /api/contacts`, `POST /api/contacts/import`, `PATCH/DELETE /api/contacts/:id`, `POST /api/contacts/bulk-delete`, `GET /api/contacts/export.csv` ·
`GET/POST /api/groups`, `PATCH/DELETE /api/groups/:id`, `GET /api/groups/:id/contacts`, `POST /api/groups/:id/members`, `DELETE /api/groups/:id/members/:contactId` (groups are static or dynamic segments `{tags[], company, status}`) ·
`GET/POST /api/templates`, `PUT/DELETE /api/templates/:id`, `POST /api/templates/:id/duplicate` ·
`GET/POST /api/suppression`, `DELETE /api/suppression/:id` ·
`GET /api/activity`, `GET /api/notifications`, `POST /api/notifications/read` ·
`GET /api/overview`, `GET /api/analytics?days=`.

## Public endpoints (no auth)

| | |
|---|---|
| `GET /health` | `{status, database}`; 503 when the database is unreachable |
| `GET /t/o/<token>.gif` | open pixel (always a GIF) |
| `GET /t/c/<token>?u=<b64url url>&s=<hmac>` | click redirect; invalid signature → 400 |
| `GET /u/<token>` | unsubscribe confirmation page |
| `POST /u/<token>` | performs the unsubscribe (also RFC 8058 one-click `List-Unsubscribe=One-Click`) |

## Database functions (PostgREST RPC, user JWT)

`save_campaign, start_campaign, pause_campaign, resume_campaign, cancel_campaign, delete_campaign, duplicate_campaign, set_followups_enabled, retry_failed_jobs, resolve_job, list_campaigns, get_campaign, list_campaign_recipients, recipient_detail, overview_stats, analytics_overview, import_contacts, group_contacts, export_my_data, check_suppressed`.
Internal (`service_role` only): `wk_claim_jobs, wk_job_mark_sending, wk_job_complete_sent, wk_job_complete_failed, wk_job_mark_ambiguous, wk_job_requeue_ambiguous, wk_list_ambiguous, wk_peek_next_due, wk_track_open, wk_track_click, wk_record_unsubscribe, wk_record_reply, wk_record_bounce, wk_upsert_account, wk_get_tokens, wk_disconnect_account, wk_rate_limit, wk_cleanup, …`.
