# Development status

_Last updated: 2026-11-17 · Branch `claude/clever-albattani-1l9evk`_

**Summary:** all three applications (Cloudflare Worker backend, React dashboard, Chrome extension), the PostgreSQL schema/queue, documentation and deployment tooling are implemented and tested end to end **in a sandbox**. **Nothing is deployed**, because that needs your Supabase / Cloudflare / Google accounts (see "Not verified" below). Follow [INSTALL.md](INSTALL.md) to deploy.

## How it was verified

| Layer | What runs | Result |
|---|---|---|
| Shared library | 21 unit tests (validation, personalisation + escaping, AES-GCM, HMAC, MIME incl. header-injection, tracking injection, CSV/paste mapping, time-zone/DST schedule maths) | ✅ 21/21 |
| Database | **Real PostgreSQL** (PGlite) runs all 7 migrations, also as one script (the Supabase SQL-Editor path), RLS tested as `authenticated`/`anon` roles | ✅ |
| Queue + engine | 84 worker tests: atomic claim, pacing 10–20 min over 100 recipients, daily/provider limits, business hours/time zones, scheduling, pause/resume/cancel, leases, crash recovery, retries/backoff, quota, auth expiry, **ambiguous-outcome handling**, follow-ups, reply/bounce detection, suppression, unsubscribe, tracking, idempotency, overlapping runs, RLS isolation, OAuth state/token encryption/refresh, attachments, Sheets, export/delete | ✅ 84/84 |
| Worker runtime | `wrangler deploy --dry-run` bundles (311 KiB gz); `wrangler dev` (real workerd) answers pixel, signed-click rejection, 401/403, CORS preflight, degraded `/health`, cron handler survives an unreachable DB | ✅ |
| Dashboard | Playwright in real Chromium against the **real Worker app + PostgreSQL + mock Gmail**: sign-up, build campaign (paste, validate, preview, HTML mode), schedule options, autosave, test email, launch, cloud scheduler sends one email then waits, tracking pixel/click/unsubscribe endpoints, reply detection, filters/detail dialog, every page renders with no console errors, mobile layout has no horizontal scroll | ✅ 12/12 steps |
| Extension | Playwright loads the **built extension** into Chromium on a mock Gmail page reproducing Gmail's compose DOM: sign-in, status pill, launcher injected next to Send, panel, To-field recipients, CSV import + mapping, follow-up stages, delivery/schedule/speed presets, test email, Send campaign (one job per recipient, compose discarded, scheduler sends individually), Open in full editor | ✅ 8/8 steps |
| Types / build | `npm run typecheck` (4 packages), dashboard + extension production builds, free-tier guard | ✅ |

Bugs found *by* these tests and fixed during development include: RLS check not seeing rows from the same statement (contact import into a group), Zod errors surfacing as HTTP 500, CORS guard rejecting the extension's `chrome-extension://` origin, a dialog animation that overrode centering, icon components invoked as functions on the login page, unlabeled form fields, OAuth redirect echoing a non-lower-cased email.

## Feature matrix

✅ implemented and tested · 🟡 implemented, limited as noted · ⛔ not implemented

| Area | Status |
|---|---|
| Persistent PostgreSQL queue, atomic claiming, leases, idempotency, retry/backoff, failed-job handling, pause/resume/cancel, recovery | ✅ |
| Cloudflare Cron scheduler (every minute) + inbound poller (every 5 min); per-account processing; overlapping-run safety | ✅ |
| Individual sending via Gmail API, Gmail message/thread ids stored, never marked sent before Gmail confirms | ✅ |
| Ambiguous outcomes reconciled (read scope) or resolved by the user; never blind retry | ✅ |
| Delivery speed presets 5–10 s … 10–20 min + custom, daily limit, provider cap, business hours, weekdays, time zone, start/end date, max concurrent per account | ✅ (🟡 5–10 s presets are best-effort on Workers Free: see docs/FREE_TIER.md) |
| Scheduled campaigns (now / 5 min / 1 h / 3 h / tomorrow 8 am, 1 pm, 7 pm / custom, time zones) | ✅ |
| Follow-ups: stages, toggle, delay, subject, content, conditions, preview, thread replies, auto-stop on reply/unsubscribe/suppression/bounce/cancel/manual disable, no duplicates | ✅ |
| Google OAuth: official flow, signed state, incremental scopes (send / read / compose / sheets), encrypted refresh tokens, refresh, `invalid_grant` → reauth flow, revoke on disconnect | ✅ code & tests with mocked Google · ❌ not run against real Google (see below) |
| Tracking: sent, opens (first/last/count, scanner hits not counted), clicks (signed), replies, bounces, failures; unknown shown as "—" | ✅ |
| Recipients: manual, paste, CSV, XLSX, Google Sheets (paste URL → worksheet), mapping, preview, duplicates, validation, suppression/unsubscribe exclusion, saved groups & segments | ✅ (🟡 Sheets uses a pasted URL, no Drive picker, to avoid the broader Drive scope; legacy `.xls` not supported) |
| Composer: subject, rich text, HTML, plain-text alt, attachments (≤3 files, 2 MB), signature, variables + fallbacks, templates, desktop/mobile preview, test email, autosave | ✅ |
| Optional AI helper (bring-your-own free endpoint; editor works without) | ✅ (not exercised against a live model) |
| Dashboard: all 11 sidebar pages, overview cards/charts/recent activity/replies/upcoming/failed jobs from PostgreSQL, campaign table + actions, per-campaign analytics, recipient table with 13 filters/search/sort/pagination/CSV export/detail, contacts (CRUD, import/export, tags, groups, segments, consent), templates, activity center, suppression, analytics, settings (sending/tracking/Gmail/notifications/signature/security incl. export & delete) | ✅ |
| Live progress: Supabase Realtime with polling fallback | 🟡 polling verified; Realtime subscription code present but not run against a live Supabase |
| Chrome extension: status pill, compose button, panel (recipients, mapping, preview, test, follow-ups, delivery, schedule, speed, advanced), Open in full editor, popup + options, MV3 | ✅ against a Gmail DOM replica · 🟡 real Gmail markup changes over time (selectors isolated in `extension/src/content/gmail.ts`) |
| Security: RLS everywhere, restricted function grants, JWT auth, CORS allow-list, rate limits, Zod validation, sanitised HTML, signed OAuth state, formula-safe CSV, storage prefixes, audit log entries | ✅ |
| Free-tier guard, `.env.example`, `wrangler.toml`, migrations, Windows `.bat` scripts, CI, manual deploy workflow | ✅ (`.bat` files not executed on Windows: the Node scripts they call are cross-platform) |
| "Gmail search" as a recipient source (GMass feature) | ⛔ not requested; would need the read scope |
| Email warm-up, A/B testing, team accounts | ⛔ out of scope |

## Not verified (needs your accounts: please read)

1. **Real Supabase**: migrations and RLS are verified on real PostgreSQL, but the PostgREST/GoTrue/Realtime/Storage layers were stood in for by a small test double. The `supabase-js` wiring (`worker/src/deps.ts`) and `supabase/all_migrations.sql` on a hosted project are untested. Typical first-run issues: enabling "Confirm email" without confirming, or a paused project.
2. **Real Google OAuth and Gmail/Sheets APIs**: OAuth, token exchange/refresh, sending and reply polling are tested against mocks of Google's documented behaviour. Google-specific behaviour I could not observe: the consent/unverified-app screens, exact error payloads for quota (`dailyLimitExceeded`, etc.), whether Gmail preserves our `Message-ID`/`X-MergeBlast-Job` headers (reconciliation relies on the latter), thread matching for follow-ups when the subject changes.
3. **Cloudflare deployment**: the bundle builds and runs in workerd, but I did not deploy. Unmeasured: real CPU time per cron run on Workers Free (10 ms limit). Mitigation: default 3 emails/run, `MAX_JOBS_PER_RUN`, and safe recovery if a run is cut off.
4. **Production Google verification** for the restricted `gmail.readonly` scope is a Google process (privacy policy, domain, security assessment). Personal use in Testing mode works with the 7-day reauthorisation.
5. **Real Gmail UI** for the extension (DOM replica only) and **Windows** execution of the `.bat` launchers.

## Next steps for you (exact order)

1. `INSTALL.bat` → fill `.env` → run `supabase/all_migrations.sql` in Supabase → create the Google OAuth client (docs/GOOGLE_OAUTH.md).
2. `DEPLOY_WORKER.bat` → open `/health` → `DEPLOY_DASHBOARD.bat` → create your account → set `ALLOW_SIGNUPS=false` and redeploy the Worker.
3. `BUILD_EXTENSION.bat` → load `extension\dist` unpacked → sign in → connect Gmail (tick *reply detection* if you want follow-ups to stop on replies).
4. Send a first campaign to **your own** addresses (test email → 2–3 recipients) and watch `npx wrangler tail` in `worker/` for the once-a-minute `scheduler {…}` line.
5. If anything differs from the above in production, the most likely places are: `worker/src/gmail.ts` (Gmail error shapes), `extension/src/content/gmail.ts` (selectors), `worker/src/inbound.ts` (bounce/reply classification).

## Possible future work

Gmail-search recipient source, Drive-based spreadsheet picker, DKIM/SPF self-check tool, A/B subject tests, per-recipient time-zone sending, webhook notifications, down-migrations, `pg_cron` as an additional keep-alive.
