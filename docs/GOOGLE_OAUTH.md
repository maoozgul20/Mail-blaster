# Google OAuth setup, consent screen, testing mode and verification

MailBlaster uses the **official Google OAuth 2.0 authorisation-code flow** with offline access. It never asks for or sees your Gmail password.
Refresh tokens are encrypted (AES-256-GCM) in your own Supabase database; the encryption key exists only as a Cloudflare secret.
The OAuth client secret lives only in Cloudflare secrets. It is never in the dashboard bundle or the extension.

> Google changes console layouts and policies regularly. Treat the click-paths below as a guide and the linked Google docs as authoritative.

## 1. Create the Google Cloud project

1. Open <https://console.cloud.google.com> → project picker → **New project** → name it `MailBlaster` → Create (free; no billing needed).
2. **APIs & Services → Library**: enable **Gmail API**. Also enable **Google Sheets API** if you want Sheets import.

## 2. OAuth consent screen (Google Auth Platform → Branding / Audience / Data access)

1. **User type: External**, publishing status **Testing**.
2. App name `MailBlaster`, your email as support and developer contact.
3. **Audience → Test users → Add users**: add **your own Gmail address** (and any other account you will connect, up to 100 test users). Only test users can authorise a Testing app.
4. **Data access → Add or remove scopes** (the app asks for these, separated so you can decline the optional ones):

| Purpose | Scope | Google classification* | Required? |
|---|---|---|---|
| Sign-in identity | `openid`, `email`, `profile` | basic | yes |
| **Send email** | `https://www.googleapis.com/auth/gmail.send` | sensitive | **yes** |
| Reply & bounce detection, send reconciliation | `https://www.googleapis.com/auth/gmail.readonly` | restricted | optional |
| "Create drafts" delivery mode | `https://www.googleapis.com/auth/gmail.compose` | restricted | optional |
| Google Sheets import | `https://www.googleapis.com/auth/spreadsheets.readonly` | sensitive | optional |

\*Classifications as published at <https://developers.google.com/identity/protocols/oauth2/scopes> and <https://support.google.com/cloud/answer/13464325>; verify there.

**Gmail "send" access alone cannot read your inbox,** so it cannot see replies. Reply/bounce detection and automatic stopping of follow-ups on reply need the optional `gmail.readonly` scope, requested separately (incremental authorisation) and clearly labelled in *Account & Integrations*. Without it, follow-ups still stop on unsubscribe, manual disable and cancel, but a reply cannot be seen. The dashboard shows "No reply detected (needs read permission)" rather than pretending.

## 3. Create the OAuth client

1. **APIs & Services → Credentials → Create credentials → OAuth client ID** → type **Web application**, name `MailBlaster Worker`.
2. **Authorised redirect URIs** → add exactly:
   `https://mailblaster-api.<your-subdomain>.workers.dev/oauth/google/callback`
   (and, only if you run the Worker locally, `http://localhost:8787/oauth/google/callback`).
   No authorised JavaScript origins are needed.
3. Copy **Client ID** → `GOOGLE_CLIENT_ID`, **Client secret** → `GOOGLE_CLIENT_SECRET` in `.env`, and set `GOOGLE_REDIRECT_URI` to the URI above. `DEPLOY_WORKER.bat` stores them as Cloudflare secrets.

## 4. Connecting, and the "unverified app" screen

In the dashboard choose the permissions and click **Continue with Google**. An unverified app shows *"Google hasn't verified this app"*:
**Advanced → Go to MailBlaster (unsafe) → Allow**. That warning is expected for your own Testing app; do not bypass it for apps you do not trust.

## 5. The 7-day expiry in Testing mode

For an External app whose publishing status is **Testing** and which requests scopes beyond basic profile, Google issues refresh tokens that **expire after 7 days**
([Google docs](https://developers.google.com/identity/protocols/oauth2#expiration)). What MailBlaster does:

* The Worker detects `invalid_grant` on refresh, marks the account **`reauth_required`**, **holds** (does not fail) all its queued jobs, creates a notification, and shows a banner on every dashboard page.
* Click **Reauthorize** (Account & Integrations). Held jobs continue automatically, in order, without duplicates.
* Nothing is lost while an account is on hold, but nothing is sent either. Plan for a weekly click, or move to production (below).

## 6. Going to production (removing the 7-day limit)

To publish an External app to *In production* so tokens last until revoked:

1. Own a domain for the app's homepage and privacy policy (a free subdomain is usually **not** acceptable to Google's verification; this is the one step that may cost money, so it is optional and never done automatically).
2. Submit the consent screen for **verification**: homepage, privacy policy, demo video showing each scope in use, justification per scope.
3. `gmail.send` and `spreadsheets.readonly` are *sensitive* (verification). `gmail.readonly` and `gmail.compose` are *restricted*: verification **plus an independent security assessment (CASA)** that is typically paid. Without it, publish with only the sensitive scopes and leave reply detection to test users, or keep the app in Testing for personal use.
4. An alternative for a single Google Workspace domain: set the user type to **Internal** (no verification, no 7-day expiry, only your organisation's users).

MailBlaster does not try to bypass any of this and never presents an unverified app as approved. The code is production-ready in structure (incremental scopes, encrypted tokens, revocation on disconnect); the verification itself is a Google process you perform with your own domain and accounts.

## 7. Revoking access

* In MailBlaster: *Account & Integrations → Disconnect* (revokes the token at Google, deletes it from the database, pauses that account's campaigns).
* Anytime at <https://myaccount.google.com/permissions>.

## 8. Troubleshooting

| Message | Cause / fix |
|---|---|
| `redirect_uri_mismatch` | The URI in the credential differs from `GOOGLE_REDIRECT_URI` (scheme, host, path, trailing slash). |
| `Error 403: access_denied` / "not completed the Google verification" | Your address is not listed under **Test users**. |
| `no_refresh_token` | You previously authorised without offline access. Remove MailBlaster at myaccount.google.com/permissions and connect again (the app always asks for consent, so this is rare). |
| `send_permission_not_granted` | You unticked "Send email on your behalf" on Google's screen. Authorise again and keep it ticked. |
| Gmail API 403 `accessNotConfigured` | Enable the **Gmail API** in the same Google Cloud project as the OAuth client. |
