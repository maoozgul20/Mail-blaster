# MailBlaster AI

A complete, self-hosted **GMass-style outreach platform that runs on free tiers only** ($0 infrastructure):
a Chrome extension inside Gmail, a React dashboard, and a Cloudflare Workers backend that keeps sending
campaigns **when your computer is off**, backed by a Supabase PostgreSQL queue.

```
 Chrome extension (Gmail compose panel) ──┐
                                          ├──▶  Cloudflare Worker API  ──▶  Supabase PostgreSQL  (source of truth + queue)
 React dashboard (Cloudflare Pages) ──────┘            ▲                          ▲
                                                       │ Cron Trigger (every minute)
                                         Cloudflare Cron Scheduler ── claims due jobs atomically ──▶ Gmail API ──▶ recipient
```

| Part | Where it lives | Free plan used |
|---|---|---|
| Backend: REST API, OAuth callback, tracking pixel/redirects, unsubscribe pages, **cron scheduler** | `worker/` → Cloudflare Workers | Workers Free + Cron Triggers |
| Dashboard (React, TypeScript, Vite, Tailwind, shadcn-style UI, Recharts, TanStack Query, React Router) | `dashboard/` → Cloudflare Pages | Pages Free |
| Chrome extension (Manifest V3, TypeScript, React) | `extension/` → loaded in Chrome | – |
| Database, auth, queue, RLS, realtime | `supabase/migrations/` → Supabase | Supabase Free |
| Shared logic (personalisation, MIME, crypto, scheduling maths, API client) | `packages/shared/` | – |

> **Nothing here needs your computer to stay on, a VPS, Redis, SQLite, a local Node server or any paid service.**
> See [docs/FREE_TIER.md](docs/FREE_TIER.md) for the honest limits of each free plan.

## What it does

* **One email per recipient.** 100 recipients → 100 recipient records → 100 independent jobs. Nobody is ever put in To/BCC together.
* **Safe pacing.** Random gap between emails (e.g. 10–20 min; presets 5–10 s, 10–60 s, 1–5 min, 5–10 min, custom), per-account daily limit, business hours, weekdays, time zone, start/end date. Gmail's own daily cap is enforced on top of any preset.
* **Persistent PostgreSQL queue** with atomic claiming (`FOR UPDATE SKIP LOCKED`), leases, idempotency keys, retries with exponential backoff, pause / resume / cancel and crash recovery.
* **Never double-sends.** A job is only `submitted` after Gmail confirms. If a response is lost the job becomes *ambiguous* and is reconciled against Gmail (or resolved by you), **never retried blindly**.
* **Automatic follow-ups** (multi-stage, conditions: no reply / not opened / no click / always) on the same scheduler, in the same Gmail thread, stopping on reply, unsubscribe, bounce, suppression, cancel or manual disable.
* **Tracking:** sent, opens (pixel), clicks (signed redirects, no open redirect), replies and bounces (optional Gmail read permission), failures. Unknown stays "Unknown / —", nothing is invented.
* **Personalisation:** `{{FirstName}} {{LastName}} {{FullName}} {{Email}} {{Company}} {{Website}} {{Position}} {{CustomField1}} {{CustomField2}}`, any CSV column, and fallbacks `{{FirstName|there}}`. Values are HTML-escaped, so CSV data can't inject markup.
* **Recipients:** paste, CSV, Excel (.xlsx), Google Sheets, saved contacts / groups / segments, duplicate + validation checks, suppression & unsubscribe exclusion, consent records.
* **Composer:** rich text + HTML source, plain-text alternative, attachments, signature, templates, desktop/mobile preview, test email, auto-saved drafts. An optional AI writing helper works with *your own* free endpoint; the editor needs no AI.
* **Security:** official Google OAuth (no passwords), refresh tokens encrypted with AES-256-GCM, Row Level Security on every table, bearer-token API (no CSRF surface), CORS allow-list, rate limiting, signed OAuth state, input validation, audit entries, per-user storage prefixes.

## Quick start (Windows)

1. Install [Node.js LTS](https://nodejs.org) and run **`INSTALL.bat`**.
2. Follow **[INSTALL.md](INSTALL.md)**: create free Supabase, Cloudflare and Google Cloud projects (about 30 minutes, no card needed) and fill in `.env`.
3. Run **`DEPLOY_WORKER.bat`**, then **`DEPLOY_DASHBOARD.bat`**, then **`BUILD_EXTENSION.bat`** and load `extension\dist` in Chrome (Developer mode).
4. Sign in to the dashboard, connect Gmail, and create your first campaign.

Details: [INSTALL.md](INSTALL.md) · [DEPLOYMENT.md](DEPLOYMENT.md) · [docs/GOOGLE_OAUTH.md](docs/GOOGLE_OAUTH.md) · [docs/API.md](docs/API.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/FREE_TIER.md](docs/FREE_TIER.md)

A ready-made extension package (placeholder API URL, set yours in the extension options) is in [`releases/mailblaster-extension.zip`](releases/mailblaster-extension.zip).

## Tests

```bash
npm install
npm test            # free-tier guard, shared unit tests, worker tests (PostgreSQL via PGlite + mock Gmail), Worker bundle build
npm run typecheck   # all four packages
npm run e2e         # real Chromium: dashboard + the built extension against the real Worker app and PostgreSQL (mock Gmail)
```

The test suite never contacts Google and never sends email. See [DEVELOPMENT_STATUS.md](DEVELOPMENT_STATUS.md) for exactly what is covered, and what could **not** be verified without your accounts (real Supabase, Cloudflare and Google OAuth).

## Responsibilities & limits (please read)

* **You** are responsible for lawful use: only email people who agreed to hear from you or where you have a lawful basis, include a working unsubscribe (on by default) and a postal address if your law requires it (CAN-SPAM, GDPR/PECR, CASL…). Tracking may need disclosure or consent in your region.
* Gmail limits apply (≈500 recipients/day for free Gmail, ≈2,000 for Workspace) and new accounts / sudden volume can be throttled by Google regardless of this tool. Warm up slowly.
* Google OAuth apps in **Testing** status expire authorisation after **7 days**; production needs Google's verification, and reply detection uses a *restricted* scope. See [docs/GOOGLE_OAUTH.md](docs/GOOGLE_OAUTH.md).
* Free tiers are **not** guaranteed 24/7 infrastructure: Supabase pauses idle projects, Cloudflare has request/CPU limits. See [docs/FREE_TIER.md](docs/FREE_TIER.md).
* Gmail's HTML/DOM changes occasionally; the extension's selectors live in one file (`extension/src/content/gmail.ts`) and the dashboard's full editor always works as a fallback.

## Repository layout

```
worker/            Cloudflare Worker (Hono): API, OAuth, tracking, cron scheduler, tests (+ e2e server)
dashboard/         React app (Cloudflare Pages) + Playwright E2E
extension/         Chrome MV3 extension + build script + Playwright E2E
packages/shared/   Pure TypeScript shared by all three
supabase/          migrations (0001 … 0006) and all_migrations.sql for the SQL editor
scripts/           deploy / key generation / free-tier guard / e2e runner
docs/              API, architecture, OAuth guide, free-tier notes
```

Licence: MIT (all dependencies are open source).
