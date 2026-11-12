// Gmail API via OAuth 2.0. Only the gmail.send scope is requested: the
// dashboard can send email as the business account but cannot read the inbox.
// The refresh token is stored encrypted in Supabase; access tokens live
// only in server memory for under an hour.

import { env, settings } from './config.js';
import { encrypt, decrypt, signState } from './crypto.js';
import { buildMime, toBase64Url } from './email.js';

export const GMAIL_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.send'];

export class GmailError extends Error {
  constructor(message, { kind = 'permanent', status = null } = {}) {
    super(message); this.kind = kind; this.status = status;   // kind: transient | permanent | auth | uncertain
  }
}

export function redirectUri(req) {
  const override = env('GOOGLE_REDIRECT_URI');
  if (override) return override;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `https://${host}/api/gmail-auth`;
}

export function authUrl(req) {
  const clientId = env('GOOGLE_CLIENT_ID');
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID is not set in Vercel');
  const redirect = redirectUri(req);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline',          // gives us a refresh token
    prompt: 'consent',               // always return a refresh token
    include_granted_scopes: 'false',
    state: signState({ r: redirect }),
  });
  const hint = settings().allowedSender;
  if (hint) params.set('login_hint', hint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode(code, redirect) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'),
      redirect_uri: redirect, grant_type: 'authorization_code',
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google token exchange failed: ${data.error_description || data.error || r.status}`);
  return data;
}

export function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return payload.email_verified === false ? null : (payload.email || null);
  } catch { return null; }
}

export function sealRefreshToken(token) { return encrypt(token); }

let cached = { token: null, exp: 0, forBlob: null };

async function accessToken(store, gmailRow) {
  if (!gmailRow || gmailRow.status !== 'connected' || !gmailRow.refresh_token_enc) {
    throw new GmailError('Gmail is not connected. Click "Connect Gmail" on the Retainers tab.', { kind: 'auth' });
  }
  if (cached.token && cached.forBlob === gmailRow.refresh_token_enc && Date.now() < cached.exp - 60000) {
    return cached.token;
  }
  let refresh;
  try { refresh = decrypt(gmailRow.refresh_token_enc); }
  catch { throw new GmailError('Stored Gmail token cannot be decrypted (was TOKEN_ENCRYPTION_KEY changed?). Reconnect Gmail.', { kind: 'auth' }); }

  let r;
  try {
    r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'),
        refresh_token: refresh, grant_type: 'refresh_token',
      }),
    });
  } catch (e) {
    throw new GmailError(`Could not reach Google: ${e.message}`, { kind: 'transient' });
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (data.error === 'invalid_grant' || data.error === 'unauthorized_client' || data.error === 'invalid_client') {
      await store.saveGmail({ status: 'error', last_error: `Google rejected the saved login (${data.error}). Reconnect Gmail.` });
      await store.log({ level: 'error', event: 'gmail_error', message: `Gmail access was revoked or expired (${data.error}). Reconnect Gmail on the Retainers tab.` });
      throw new GmailError('Gmail access was revoked or expired. Reconnect Gmail.', { kind: 'auth' });
    }
    throw new GmailError(`Google token refresh failed (${r.status})`, { kind: r.status >= 500 ? 'transient' : 'permanent' });
  }
  if (data.refresh_token) {
    // Google rotated the refresh token: store the new one
    const blob = encrypt(data.refresh_token);
    await store.saveGmail({ refresh_token_enc: blob });
    gmailRow.refresh_token_enc = blob;
  }
  cached = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000, forBlob: gmailRow.refresh_token_enc };
  return cached.token;
}

const NOT_SENT_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ERR_INVALID_URL']);

async function postSend(token, raw) {
  let r;
  try {
    r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    const code = e?.cause?.code || e?.code;
    // Connection never opened: definitely not sent, safe to retry.
    if (NOT_SENT_CODES.has(code)) throw new GmailError(`Network error (${code})`, { kind: 'transient' });
    // Timed out / dropped after sending: Gmail may or may not have sent it.
    throw new GmailError(`No response from Gmail (${code || e.name}). It may or may not have been sent.`, { kind: 'uncertain' });
  }
  const data = await r.json().catch(() => ({}));
  if (r.ok) return data;
  const msg = data?.error?.message || `HTTP ${r.status}`;
  if (r.status === 401) throw new GmailError(msg, { kind: 'auth', status: 401 });
  if (r.status === 429 || r.status >= 500) throw new GmailError(msg, { kind: 'transient', status: r.status });
  throw new GmailError(msg, { kind: 'permanent', status: r.status });
}

/**
 * Send one email from the connected business Gmail.
 * Retries once on rate limits / Google errors. Returns { id, threadId }.
 */
export async function sendEmail(store, gmailRow, { to, subject, text, html }) {
  const cfg = settings();
  const raw = toBase64Url(buildMime({
    fromName: cfg.fromName, fromEmail: gmailRow.email, to, replyTo: cfg.replyTo, subject, text, html,
  }));
  let token = await accessToken(store, gmailRow);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await postSend(token, raw);
      store.saveGmail({ last_used_at: new Date().toISOString(), last_error: null }).catch(() => {});
      return res;
    } catch (e) {
      if (e.kind === 'auth' && e.status === 401 && attempt === 1) {
        cached = { token: null, exp: 0, forBlob: null };
        token = await accessToken(store, gmailRow);
        continue;
      }
      if (e.kind === 'transient' && attempt === 1) {
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      throw e;
    }
  }
}

export async function revoke(gmailRow) {
  if (!gmailRow?.refresh_token_enc) return;
  try {
    const token = decrypt(gmailRow.refresh_token_enc);
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
  } catch { /* best effort */ }
  cached = { token: null, exp: 0, forBlob: null };
}

// Test hook
export function _resetTokenCache() { cached = { token: null, exp: 0, forBlob: null }; }
