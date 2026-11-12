// /api/gmail-auth : Google sends the browser back here after you approve
// access. We check the request is one we started, swap the one-time code for
// a refresh token, encrypt it and store it. Nothing secret reaches the browser.

import { settings } from './_lib/config.js';
import { verifyState } from './_lib/crypto.js';
import { createStore } from './_lib/db.js';
import { exchangeCode, emailFromIdToken, sealRefreshToken, GMAIL_SCOPES } from './_lib/gmail.js';

function page(res, ok, message) {
  res.statusCode = ok ? 200 : 400;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Gmail connection</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
${ok ? '<meta http-equiv="refresh" content="3;url=/?reminders=gmail-connected">' : ''}</head>
<body style="margin:0;background:#080B0F;color:#F0F4F8;font-family:Inter,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">
<div style="background:#0E1318;border:1px solid rgba(255,255,255,0.11);border-radius:12px;padding:28px 32px;max-width:440px;text-align:center">
<div style="font-size:32px;margin-bottom:8px">${ok ? '✓' : '⚠'}</div>
<div style="font-size:16px;font-weight:700;margin-bottom:8px;color:${ok ? '#00F5A8' : '#FF5252'}">${ok ? 'Gmail connected' : 'Gmail not connected'}</div>
<div style="font-size:13px;color:#8895A7;line-height:1.6">${esc(message)}</div>
<a href="/" style="display:inline-block;margin-top:18px;color:#00F5A8;font-size:13px">Back to dashboard</a>
</div></body></html>`);
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'https://local');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const state = verifyState(url.searchParams.get('state'));

  if (error) return page(res, false, `Google said: ${error}. Nothing was changed.`);
  if (!state || !code) return page(res, false, 'This link has expired or did not come from the dashboard. Start again from the Retainers tab.');

  const store = createStore();
  try {
    const tokens = await exchangeCode(code, state.r);
    if (!tokens.refresh_token) {
      return page(res, false, 'Google did not return a long-lived token. Remove "SWH Dashboard" at myaccount.google.com/permissions, then connect again.');
    }
    const granted = String(tokens.scope || '').split(' ');
    if (!granted.includes(GMAIL_SCOPES[2])) {
      return page(res, false, 'Permission to send email was not granted. Connect again and tick the "Send email on your behalf" box.');
    }
    const email = emailFromIdToken(tokens.id_token);
    if (!email) return page(res, false, 'Could not read which Gmail account was used. Try again.');
    const allowed = settings().allowedSender;
    if (allowed && allowed.toLowerCase() !== email.toLowerCase()) {
      return page(res, false, `You signed in as ${email}, but only ${allowed} is allowed to send reminders. Try again with that account.`);
    }

    await store.saveGmail({
      email, refresh_token_enc: sealRefreshToken(tokens.refresh_token), scope: tokens.scope,
      status: 'connected', connected_at: new Date().toISOString(), last_error: null,
    });
    await store.log({ event: 'gmail_connected', message: `Gmail connected: reminders will be sent from ${email}.` });
    return page(res, true, `Reminders will be sent from ${email}. Taking you back to the dashboard...`);
  } catch (e) {
    await store.log({ level: 'error', event: 'gmail_error', message: `Gmail connection failed: ${e.message}` }).catch(() => {});
    return page(res, false, `Connection failed: ${e.message}`);
  }
}

