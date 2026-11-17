# Architecture & reliability guarantees

## Data flow

1. **Create**: `save_campaign()` stores the campaign, follow-up stages and **one `campaign_recipients` row per person** (validated, de-duplicated, suppressed ones pre-marked).
2. **Start**: `start_campaign()` (atomic) re-checks suppression, creates **one `sending_jobs` row per eligible recipient** (`idempotency_key = recipient_id:0`, unique) with `run_after = start time`, and sets the campaign `scheduled` or `queued`.
3. **Cron (every minute)** → `runScheduler()` calls `wk_claim_jobs()`:
   * recovers expired leases (`claimed` → back to `queued`; `sending` → **`ambiguous`**),
   * locks eligible accounts with `FOR UPDATE SKIP LOCKED` (so overlapping runs cannot both proceed) and honours `max_concurrent`, `blocked_until` (quota) and the per-account pacing gate `next_send_at`,
   * for each account walks due jobs (`SKIP LOCKED`) and applies, in this order: campaign end date → **suppression / unsubscribe / bounce** → follow-up rules (reply, opened, clicked, disabled, stopped) → **business hours + weekdays (campaign time zone)** → **daily limit = min(campaign limit, account provider cap)**,
   * claims the first eligible job (`claimed`, lease, `attempts+1`), sets the account's next slot to `now + random(min…max)`, and returns the fully hydrated job.
4. **Send**: render (merge tags HTML-escaped, tracking pixel/links, unsubscribe footer + `List-Unsubscribe` headers) → access token (decrypted/refreshed in the Worker) → `wk_job_mark_sending()` (aborts if the campaign was paused/cancelled meanwhile) → Gmail `messages.send` (one recipient, no Cc/Bcc).
5. **Record**: only on a Gmail success `wk_job_complete_sent()` marks the job `submitted`, writes `email_messages` (Gmail message + thread id), updates the recipient, logs activity, and **creates the next follow-up job** (unique `recipient_id:step` → can never be duplicated) with `run_after = now + stage delay`.
6. **Inbound (every 5 min, optional read scope)**: new messages in threads we started are classified: bounce (permanent → suppress + cancel everything for that address), auto-reply (ignored), reply (recorded, follow-ups cancelled).

## Job states

```
queued ──claim──▶ claimed ──mark_sending──▶ sending ──Gmail OK──▶ submitted
  ▲                 │ lease expiry              │ lease expiry / lost response / HTTP 500
  └─────────────────┘                           ▼
                                           ambiguous ──reconcile(found)──▶ submitted
                                                    └──reconcile(not found, >5 min)──▶ queued
                                                    └──user: "it was sent" / "retry"
queued/claimed ──permanent error──▶ failed          queued ──suppressed/ended──▶ skipped|cancelled
```

* **Transient** (502/503/504, Google token endpoint down): exponential backoff `60·2^attempt s + jitter`, max 5 attempts, then `failed` (`transient_exhausted`, retryable from the UI).
* **Quota** (403 limit, 429): account `blocked_until`, job kept, attempt not consumed.
* **Auth** (401, `invalid_grant`): account `reauth_required`, jobs held, user notified.
* **Invalid recipient / other 4xx**: final failure on that recipient only.
* **Ambiguous** (no HTTP response after the request was sent, bare 500, lease expired while sending, DB write failed after Gmail accepted): **never retried blindly**. Each message carries `X-MergeBlast-Job: <job id>` and `Message-ID: <mb.<job id>@sender-domain>`; with the read scope the Worker searches *Sent* for that header to decide. Without the scope the job waits for your decision.

## Why PostgreSQL is the scheduler

Cloudflare Cron is only a *clock*. All scheduling state (`run_after`, `next_send_at`, leases, counters) lives in PostgreSQL, so deploys, crashes, missed ticks and overlapping runs are harmless. No in-memory queue, no Redis, no Cloudflare Queues retention to depend on.

## Security model

* Browser/extension → Worker: `Authorization: Bearer <Supabase JWT>` (no cookies ⇒ no CSRF). The Worker verifies the JWT with Supabase and then calls PostgREST **with the user's JWT**, so Row Level Security enforces isolation in the database itself.
* Users can read their own rows; they cannot write campaigns, recipients, jobs or events directly. Only `SECURITY DEFINER` functions that check `auth.uid()` can. `wk_*` functions are executable by `service_role` only; `oauth_tokens` and `rate_limits` have RLS with no policies.
* The service-role key exists only as a Worker secret. Tokens are AES-256-GCM encrypted (random IV; wrong key or tampering fails authentication).
* Public endpoints: tracking pixel (always returns a GIF), click redirect (**HMAC-signed URL, so it cannot be an open redirect**), unsubscribe (GET only confirms; POST acts, so scanners cannot unsubscribe people; supports RFC 8058 one-click), OAuth callback (HMAC-signed, expiring `state`).
* Inputs validated with Zod at the edge and CHECK constraints/limits in SQL; HTML sanitised before sending and previewed in script-less sandboxed iframes; CSV export neutralises formula injection; attachments allow-listed by type/extension, ≤2 MB, stored under `<user id>/` in a private bucket.

## Tracking accuracy (stated honestly)

Opens are an invisible-pixel signal: image blocking hides real opens, Apple Mail Privacy Protection and corporate scanners create false ones. Hits within 8 s of sending (and clicks within 5 s) are recorded but **not counted**. Replies/bounces are only known when the optional read permission is granted; otherwise the UI shows "—/Not available".
