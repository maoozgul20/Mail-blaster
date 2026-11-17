# Free-tier limits, and how MailBlaster stays inside them

MailBlaster is designed for **$0**. Free plans have limits and **no provider promises unlimited or guaranteed 24/7 service**.
The numbers below were current when this was written; **verify them** before relying on them:
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/) ·
[Pages limits](https://developers.cloudflare.com/pages/platform/limits/) ·
[Supabase pricing/limits](https://supabase.com/pricing) ·
[Gmail sending limits](https://support.google.com/a/answer/166852).

## What can charge money (and what prevents it)

| Risk | Guard |
|---|---|
| Cloudflare Workers Paid / Queues / Durable Objects / R2 / D1 | None are used. `npm run check:free` (also run by `DEPLOY_WORKER.bat` and CI) **fails** if `wrangler.toml` enables any paid-only feature, custom routes, or more than 5 cron triggers. On the Free plan Cloudflare returns errors when you exceed limits; it does not bill overage. Do not click *Upgrade*. |
| Supabase | Stay on the **Free** plan (one of the 2 free projects). Free projects have no pay-as-you-go overage; you are blocked or paused at quota. Do not enable add-ons or upgrade the org. |
| Google Cloud | Gmail and Sheets APIs are free for this usage. No billing account is required or should be attached. |
| Domain | Not needed: `*.workers.dev` and `*.pages.dev` are free. |
| Paid AI | Not used. The optional AI helper only calls an endpoint *you* configure (e.g. local Ollama or a free tier). |

## Cloudflare Workers (Free)

| Limit | Typical value | Impact / design response |
|---|---|---|
| Requests | 100,000 / day | API + tracking pixels + clicks + cron. A 5,000-email campaign with tracking is roughly 10k–30k requests over its life. Heavy open tracking on huge lists is the main consumer. |
| CPU time | 10 ms per invocation | Rendering + signing one email is a few ms (keys are cached per isolate). Default **3 emails per cron run** (`MAX_JOBS_PER_RUN`); lower to `1` if logs show *exceeded CPU*. A killed run is safe: claimed jobs recover via lease expiry, and an interrupted in-flight send becomes *ambiguous*, never a duplicate. |
| Subrequests | 50 per invocation | ≈5 per email (claim, token, mark, Gmail, complete) → the 3-email default stays far below. |
| Cron Triggers | 5 per account | Uses 2: every minute (send engine) and every 5 minutes (replies/bounces). |
| Cron granularity | 1 minute | Pacing precision is about ±1 minute. **5–10 second presets are best-effort**: one run waits up to ~20 s for the next due email, so on Free the effective throughput of fast presets is limited by CPU/wall budget (a few emails per minute). The daily limit and Gmail caps are always enforced first. |
| Bundle size | 3 MB compressed | Current bundle ≈ 0.3 MB. |
| Memory | 128 MB | Attachments are capped at 2 MB total per campaign. |

## Cloudflare Pages (Free)

Static hosting for the dashboard: unlimited bandwidth for static assets; 500 builds/month does not apply because we deploy a prebuilt folder with `wrangler pages deploy`.

## Supabase (Free)

| Limit | Typical value | Impact |
|---|---|---|
| **Inactivity pausing** | Free projects are paused after ~1 week without activity | The send cron queries the database every minute, which counts as activity, so an *active deployment normally never idles*. If you stop the Worker (or Cloudflare stops it) for a week, the project may pause: open Supabase and click **Restore**. Campaigns resume afterwards; overdue jobs are sent respecting pacing. Pausing is not data loss, but Supabase may delete projects paused for a long time, so keep backups (Settings → *Export all my data*). |
| Database size | 500 MB | ≈ 1 KB per recipient + events: hundreds of thousands of events fit. `wk_cleanup` prunes notifications/logs/rate-limit rows. |
| Egress | ~5 GB / month | Dashboard queries are paged. |
| Realtime | 200 concurrent connections | Live campaign progress; falls back to polling automatically. |
| Storage | 1 GB | Attachments only (private bucket, 2 MB cap per campaign). |
| Auth | 50k MAU | Far beyond a personal tool. |
| Backups | No point-in-time recovery on Free | Use the in-app data export; Supabase may keep daily backups per its current policy. |

## Gmail (the limits that matter most)

* Free Gmail ≈ **500 recipients/day**, Google Workspace ≈ **2,000/day**; rolling 24-hour windows; new or low-reputation accounts are throttled sooner. MailBlaster's per-account `daily_cap` (default 500) is a hard ceiling that no campaign setting can override.
* On a Gmail `403 dailyLimitExceeded / rateLimitExceeded` or `429`, the account is **paused for a few hours**, the job is kept (no attempt consumed) and resumes afterwards.
* Cold email to people who did not opt in can get your Gmail account restricted. Warm up slowly (start with 20–30/day), keep the unsubscribe link, and honour opt-outs.

## Graceful degradation (implemented and tested)

| Failure | Behaviour |
|---|---|
| Supabase unreachable / paused | Cron run logs the error and exits; nothing is lost; next minute retries. `/health` returns 503. |
| Worker killed mid-run (CPU/deploy) | Claimed jobs return to the queue after the 2-minute lease; mid-send jobs become *ambiguous* and are reconciled, never blindly retried. |
| Gmail 5xx/gateway errors | Exponential backoff, 5 attempts, then *failed* (you can retry from the campaign page). |
| Gmail quota | Account paused until it resets; jobs kept. |
| Google authorisation expired | Account held, banner + notification; resumes after *Reauthorize*. |
| Two cron runs overlap | `FOR UPDATE SKIP LOCKED` on accounts and jobs: impossible to claim the same job twice. |
