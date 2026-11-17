# Deployment guide

Everything deploys to **free** plans. First-time setup is in [INSTALL.md](INSTALL.md); this page covers the moving parts, updates, CI and operations.

## Components and where configuration lives

| Component | Deploy command | Configuration |
|---|---|---|
| Database | paste `supabase/all_migrations.sql` into the Supabase SQL Editor (or `supabase db push` with the Supabase CLI) | Supabase dashboard |
| Worker (API + cron) | `DEPLOY_WORKER.bat` → `npm run deploy:worker` | `worker/wrangler.toml` `[vars]` (written from `.env`) + 4 Cloudflare **secrets** |
| Dashboard | `DEPLOY_DASHBOARD.bat` → `npm run deploy:dashboard` | build-time `VITE_API_BASE_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (public values only) |
| Extension | `BUILD_EXTENSION.bat` | `API_BASE_URL`, `DASHBOARD_URL` (defaults; editable in the extension options) |

### Worker variables and secrets

| Name | Kind | Meaning |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | var | public; RLS protects data |
| `API_BASE_URL`, `FRONTEND_URL`, `GOOGLE_REDIRECT_URI` | var | used in links, CORS and OAuth |
| `SUPABASE_SERVICE_ROLE_KEY` | **secret** | full DB access: Worker only |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | **secret** | OAuth client |
| `ENCRYPTION_KEY` | **secret** | 32 random bytes, base64; AES key for tokens and HMAC key for tracking/OAuth state |
| `ALLOW_SIGNUPS` | var, optional | `false` closes registration |
| `ALLOWED_EXTENSION_IDS` | var, optional | pin the extension IDs allowed to call the API |
| `ALLOWED_ORIGINS` | var, optional | extra browser origins (e.g. `http://localhost:5173`) |
| `MAX_JOBS_PER_RUN` | var, optional | emails per cron run (default 3, max 10) |

Manual alternative to the scripts: edit `[vars]` in `worker/wrangler.toml`, then in `worker/`:

```bash
npx wrangler login
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY   # repeat for the other three
npx wrangler deploy
```

Cron triggers (`* * * * *` and `*/5 * * * *`) are part of `wrangler.toml` and are registered by `wrangler deploy`. Check *Workers & Pages → mailblaster-api → Settings → Triggers*.

## Updating

```bash
git pull
npm install
npm test                      # optional but recommended
```

* **Database changes**: new files in `supabase/migrations/` are additive. Regenerate and run only the *new* migration in the SQL Editor (`npm run migrations:combine` rebuilds the combined file; do not re-run old migrations).
* Re-run `DEPLOY_WORKER.bat` / `DEPLOY_DASHBOARD.bat`; rebuild the extension and click *Reload* on `chrome://extensions`.
* **Safe to deploy mid-campaign**: state is in PostgreSQL. A run interrupted by a deploy leaves at most one job in `claimed` (recovered after 2 minutes) or `ambiguous` (reconciled, never duplicated).

## Rollback

`npx wrangler rollback` (in `worker/`) restores the previous Worker version; Pages keeps previous deployments (Pages → Deployments → *Rollback*). Database migrations have no automatic down-scripts: take an export first (*Settings → Export all my data*) for destructive changes.

## GitHub Actions (optional)

* `.github/workflows/ci.yml` runs on every push/PR: install, typecheck, unit/DB/HTTP tests, Worker bundle build (a deployment dry-run), dashboard + extension builds, free-tier guard, and uploads the extension ZIP as an artifact. **It uses no secrets and never touches Google.**
* `.github/workflows/deploy.yml` is a **manual** workflow (*Actions → Deploy → Run*) that deploys the Worker and dashboard. Add these repository **secrets** first: `CLOUDFLARE_API_TOKEN` (permissions *Workers Scripts: Edit*, *Cloudflare Pages: Edit*), `CLOUDFLARE_ACCOUNT_ID`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ENCRYPTION_KEY`, `API_BASE_URL`, `FRONTEND_URL`. It never runs automatically.

## Verifying a deployment

```bash
curl https://mailblaster-api.<sub>.workers.dev/health          # {"status":"ok","database":"ok"}
npx wrangler tail --format pretty        # (in worker/) live logs: look for "scheduler {...}" once a minute
```

A healthy idle scheduler line looks like `scheduler {"claimed":0,"submitted":0,...,"errors":[]}`.
In Supabase → SQL Editor: `select status, count(*) from sending_jobs group by 1;` shows the queue.

## Operations notes

* **Pause everything**: *Campaigns → Pause*, or disconnect the Gmail account, or comment out the crons and redeploy.
* **Supabase paused?** Open the project and click *Restore* (see [docs/FREE_TIER.md](docs/FREE_TIER.md)).
* **Rotate `ENCRYPTION_KEY`**: stored tokens become unreadable; accounts show *reauthorization needed* and are reconnected with one click (links already sent keep working only if the key is unchanged: tracking/click signatures and unsubscribe tokens are separate, but click links use the same key, so rotate between campaigns).
* **Unsubscribe links point at the Worker URL** (`/u/<token>`); keep that URL stable for as long as old emails may be clicked.
* **Never** put `SUPABASE_SERVICE_ROLE_KEY`, the Google client secret or `ENCRYPTION_KEY` in the dashboard, the extension, `wrangler.toml` or git. `npm run check:free` also fails if a service-role key appears in `wrangler.toml`.
