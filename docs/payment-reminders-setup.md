# Payment reminders: setup

## 1. Database (once)
Supabase → SQL Editor → New query → paste `sql/payment_reminders.sql` → Run.

## 2. Google Cloud (once, about 10 minutes)
1. console.cloud.google.com → create a project called `SWH Dashboard`.
2. APIs & Services → Library → search **Gmail API** → Enable.
3. Google Auth Platform → Branding: app name `SWH Dashboard`, support email = your business email.
4. Audience:
   - Business email on Google Workspace: choose **Internal**.
   - Plain @gmail.com account: choose **External**, add yourself as a test user, then click **Publish app**. If you skip Publish, Google expires the connection every 7 days.
5. Data Access → Add scope `https://www.googleapis.com/auth/gmail.send`.
6. Clients → Create client → **Web application** → Authorized redirect URIs:
   - `https://YOUR-DASHBOARD-DOMAIN/api/gmail-auth`
   - `https://YOUR-PREVIEW-DOMAIN/api/gmail-auth` (for testing on the preview)
7. Copy the **Client ID** and **Client secret**.

## 3. Vercel → Project → Settings → Environment Variables
| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | from step 2.7 |
| `GOOGLE_CLIENT_SECRET` | from step 2.7 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API keys → service_role |
| `TOKEN_ENCRYPTION_KEY` | random string, run `openssl rand -hex 32` in Terminal |
| `CRON_SECRET` | another random string, `openssl rand -hex 32` |
| `DASHBOARD_ADMIN_PASSCODE` | a long passcode of your choice |
| `WHOP_WEBHOOK_SECRET` | from step 4 |
| `GMAIL_ALLOWED_SENDER` | optional: the only Gmail address allowed to connect |
| `REMINDER_TEST_EMAIL` | optional: where test emails go (default: the connected Gmail) |
| `BUSINESS_TIMEZONE` | optional, default `Asia/Dubai` |

Do **not** add `REMINDERS_LIVE` until live sending is approved. Without it, no client is ever emailed.

## 4. Whop webhook
Whop dashboard → Developer → Webhooks → Create → URL `https://YOUR-DASHBOARD-DOMAIN/api/whop-webhook`, event `payment.succeeded` → copy the secret (`ws_...`) into `WHOP_WEBHOOK_SECRET`.

## 5. Connect Gmail
Redeploy → Retainers tab → Unlock (passcode) → **Connect Gmail** → sign in with the business account → Allow.

## Going live (only after approval)
Add `REMINDERS_LIVE` = `true` in Vercel and redeploy. Remove it to switch back to test mode instantly.

## Tests
`node --test tests/*.test.mjs`
