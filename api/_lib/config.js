// Payment reminder settings. Secrets come ONLY from Vercel environment
// variables and never reach the browser.

export const SUPABASE_URL = 'https://qstlyvauppjkdiwpgtql.supabase.co';
export const WHOP_COMPANY_ID = 'biz_6YYccxU9EzDgfU';

// Payments that are never instalments (same rules as api/whop-sync.js)
export const LT_PRODUCT_IDS = ['prod_Q0nZad1rnebtx'];
export const LT_AMOUNTS = [27, 97];

export const STAGES = [
  { key: 'pre3',  offset: -3, label: '3 days before' },
  { key: 'due',   offset: 0,  label: 'Due date' },
  { key: 'over2', offset: 2,  label: '2 days overdue' },
  { key: 'over5', offset: 5,  label: '5 days overdue' },
  { key: 'over7', offset: 7,  label: '7 days overdue' },
];

// If a daily run is missed, a reminder can still go out up to this many
// days late. Older stages are skipped (never a backlog of emails).
export const CATCH_UP_DAYS = 2;
export const MAX_SEND_ATTEMPTS = 3;
export const MAX_SENDS_PER_RUN = 40;    // runaway protection
export const AMOUNT_TOLERANCE = 1;      // USD

export function env(name, fallback = undefined) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export function settings() {
  return {
    // Live sending is OFF unless this is exactly "true". Anything else = test mode.
    live: env('REMINDERS_LIVE') === 'true',
    timezone: env('BUSINESS_TIMEZONE', 'Asia/Dubai'),
    fromName: env('REMINDER_FROM_NAME', 'Scaling With High Ticket'),
    signOff: env('REMINDER_SIGN_OFF', 'The SWH Team'),
    replyTo: env('REMINDER_REPLY_TO', null),
    testEmail: env('REMINDER_TEST_EMAIL', null),          // falls back to the connected Gmail
    allowedSender: env('GMAIL_ALLOWED_SENDER', null),     // optional: only this account may connect
  };
}

// Which required variables are missing (shown on the dashboard, values never shown)
export function missingConfig() {
  const required = [
    'SUPABASE_SERVICE_ROLE_KEY', 'DASHBOARD_ADMIN_PASSCODE', 'CRON_SECRET',
    'TOKEN_ENCRYPTION_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'WHOP_WEBHOOK_SECRET',
  ];
  return required.filter(k => !env(k));
}
