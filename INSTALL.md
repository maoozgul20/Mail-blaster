# Install MailBlaster AI on Windows (all free, about 30–40 minutes)

You will create four free accounts/projects and paste a few values into one file (`.env`). **You never need a credit card.**
Never paste secrets into chat, issues or commits: they go only into `.env` (git-ignored) and Cloudflare secrets.

| # | What | Cost |
|---|---|---|
| 1 | Node.js + Git on your PC | free |
| 2 | Supabase project (database + login) | free plan |
| 3 | Cloudflare account (Worker + Pages) | free plan |
| 4 | Google Cloud project (Gmail OAuth) | free |

---

## 1. Install the tools

1. Install **Node.js LTS** (v20 or newer) from <https://nodejs.org>.
2. Install **Git for Windows** from <https://git-scm.com/download/win>.
3. Open *Command Prompt* and check: `node -v` and `git --version`.

## 2. Get the code (your GitHub repository)

The code is already in your repository `maoozgul20/Mail-blaster` (branch `claude/clever-albattani-1l9evk`; merge it into `main` with a pull request whenever you like).

```bash
git clone https://github.com/maoozgul20/Mail-blaster.git
cd Mail-blaster
git checkout claude/clever-albattani-1l9evk
```

Double-click **`INSTALL.bat`**. It installs dependencies and creates `.env` from `.env.example`. Keep `.env` open in Notepad: you will fill it in below.

> To keep your own copy under your account: create a *private* repository on GitHub, then `git remote set-url origin <your-url>` and `git push -u origin main`. `.env` is git-ignored, so secrets stay on your PC.

## 3. Supabase (free PostgreSQL + login)

1. Sign up at <https://supabase.com> → **New project** (choose the **Free** plan, a region near you, and a strong database password, which you will not need again).
2. When it finishes: **Project Settings → API**. Copy into `.env`:
   * `SUPABASE_URL` = *Project URL*
   * `SUPABASE_ANON_KEY` = the *anon public* key, **or the new "Publishable key"** (`sb_publishable_…`)
   * `SUPABASE_SERVICE_ROLE_KEY` = the *service_role* key, **or the new "Secret key"** (`sb_secret_…`) (**secret**: only the Worker uses it)
   * (Supabase renamed the keys: both styles are supported. If your dashboard has an *API Keys* page with a *Legacy API keys* tab, either works.)
3. **SQL Editor → New query**: open `supabase/all_migrations.sql` from this repo in Notepad, copy everything, paste, **Run**. It should end with *Success*. (It creates all 21+ tables, Row Level Security, the queue functions, the private attachments bucket and realtime.)
4. **Authentication → Providers → Email**: for a personal install you can switch off *Confirm email* so you can sign in immediately. If you leave it on, click the confirmation email first.
5. After the dashboard is deployed (step 8) set **Authentication → URL Configuration → Site URL** to your dashboard URL.

## 4. Cloudflare (free Worker + Pages)

1. Sign up at <https://dash.cloudflare.com/sign-up> (free plan; no card needed for Workers/Pages free).
2. **Workers & Pages → Overview**: if asked, choose your free **workers.dev subdomain** (e.g. `yourname`). Your API will be `https://mailblaster-api.yourname.workers.dev`.
3. Put these in `.env`:
   ```
   API_BASE_URL=https://mailblaster-api.yourname.workers.dev
   FRONTEND_URL=https://mailblaster-dashboard.pages.dev
   CLOUDFLARE_ACCOUNT_ID=<Workers & Pages → right sidebar: Account ID>
   ```
   (If `mailblaster-dashboard` is taken on pages.dev, add `PAGES_PROJECT=mailblaster-yourname` to `.env` and use `https://mailblaster-yourname.pages.dev` as `FRONTEND_URL`.)
4. Generate the encryption key (encrypts Google refresh tokens at rest) and paste it into `.env`:
   ```bash
   node scripts/gen-key.mjs
   ```
   `ENCRYPTION_KEY=<the printed line>`. Keep a copy somewhere safe: losing it means reconnecting Gmail.

## 5. Google Cloud (Gmail OAuth)

Follow **[docs/GOOGLE_OAUTH.md](docs/GOOGLE_OAUTH.md)** (10 minutes): create a project, enable the Gmail API (and Google Sheets API if you want Sheets import), configure the OAuth consent screen in *Testing* mode with **your own Gmail as a test user**, create an OAuth client (*Web application*) with this redirect URI:

```
https://mailblaster-api.yourname.workers.dev/oauth/google/callback
```

Copy the *Client ID* and *Client secret* into `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and set `GOOGLE_REDIRECT_URI` to the same URL as above.

## 6. Deploy the backend

Double-click **`DEPLOY_WORKER.bat`**. The first time, a browser window opens to log in to Cloudflare. The script:

* verifies nothing paid is configured (`npm run check:free`),
* writes the public values into `worker/wrangler.toml`,
* deploys the Worker with its two cron triggers (every minute = send engine, every 5 minutes = reply/bounce detection),
* stores `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ENCRYPTION_KEY` as **Cloudflare secrets**.

Check <https://mailblaster-api.yourname.workers.dev/health> → `{"status":"ok","database":"ok"}`.

## 7. Deploy the dashboard

Double-click **`DEPLOY_DASHBOARD.bat`** (builds with your API URL and publishes to Cloudflare Pages). Open the printed `https://….pages.dev` URL, click **Create one** and register. Then optionally close registration so strangers can't use your free database: add `ALLOW_SIGNUPS=false` to `.env` and run `DEPLOY_WORKER.bat` again.

## 8. Build and install the Chrome extension

1. Make sure `.env` has `API_BASE_URL` and `FRONTEND_URL` (the extension also reads `DASHBOARD_URL`, which defaults to `FRONTEND_URL`).
2. Double-click **`BUILD_EXTENSION.bat`**. It creates `extension\dist` and `extension\mailblaster-extension.zip`.
3. Chrome → `chrome://extensions` → switch on **Developer mode** → **Load unpacked** → select the `extension\dist` folder.
4. Click the MailBlaster icon → *Options* (opens automatically on first install) → sign in with your dashboard account.

(To use the prebuilt `releases/mailblaster-extension.zip`: unzip, load it unpacked, then enter your API and dashboard URLs in the options page. Chrome will ask permission for that address.)

## 9. Connect Gmail

Dashboard → **Settings → Account & Integrations**. "Send email" is always requested. Tick **reply detection** if you want replies/bounces detected (needed to stop follow-ups when someone answers), and **Sheets** / **drafts** only if you will use them. Click **Continue with Google**.

Because your Google app is in *Testing* mode you will see **“Google hasn't verified this app”**: click **Advanced → Go to … (unsafe)** (it is your own app) → **Allow**. Authorisation expires after **7 days** in Testing mode; just click *Reauthorize* (see the guide for how to avoid this).

## 10. Create your first campaign

1. Dashboard → **New campaign**. For the first run use 2–3 **of your own addresses** (paste them in the *Paste / type* tab).
2. Write the subject and body (try `Hi {{FirstName|there}}`), click **Send test email to myself** and check your inbox.
3. Leave the default pacing (10–20 min, 30/day), **Send campaign** → *Start sending*.
4. Watch the campaign page: recipients move from *Queued* to *Sent* one at a time. You can close the browser and switch the PC off: the Cloudflare cron keeps going.
5. In Gmail: click **Compose**; the **MailBlaster** button appears next to **Send**. Use its panel to import a CSV/Excel/Google Sheet or use the To field, set follow-ups and schedule, then **Send campaign** (never Gmail's own Send, which would send one message to everybody).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `DEPLOY_WORKER.bat`: “Missing in .env” | Fill the named values in `.env`. |
| `/health` says `database: unavailable` | Check `SUPABASE_URL` / service-role key; a free project may be **paused** (open it in Supabase and click *Restore*). |
| “Google OAuth is not configured” | Secrets missing: run `DEPLOY_WORKER.bat` again after filling `.env`. |
| Google error `redirect_uri_mismatch` | The URI in Google Cloud must equal `GOOGLE_REDIRECT_URI` exactly (https, no trailing slash). |
| “Access blocked: app not verified / not a test user” | Add your Gmail under *OAuth consent screen → Test users*. |
| Sending paused, banner “Reconnect Gmail” | Testing-mode token expired (7 days): *Account & Integrations → Reauthorize*. Queued mail continues automatically. |
| Extension button missing in Gmail | Reload the Gmail tab; open the compose window; check the extension is enabled. Gmail's markup changes sometimes: use the dashboard editor meanwhile and report the selector in `extension/src/content/gmail.ts`. |
| Dashboard shows CORS errors | `FRONTEND_URL` in `.env` must match the dashboard URL exactly; redeploy the Worker. |

See [DEPLOYMENT.md](DEPLOYMENT.md) for updates, CI deploys and rollback.
