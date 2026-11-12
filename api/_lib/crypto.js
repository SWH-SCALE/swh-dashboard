// Encryption for the Gmail refresh token, signed OAuth state, constant-time
// comparisons. Uses Node's built-in crypto only.

import crypto from 'node:crypto';
import { env } from './config.js';

function masterSecret() {
  const s = env('TOKEN_ENCRYPTION_KEY');
  if (!s || s.length < 32) throw new Error('TOKEN_ENCRYPTION_KEY must be set (at least 32 characters)');
  return s;
}

function deriveKey(purpose) {
  return Buffer.from(crypto.hkdfSync('sha256', masterSecret(), 'swh-reminders', purpose, 32));
}

export function encrypt(plain) {
  const key = deriveKey('gmail-refresh-token');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

export function decrypt(blob) {
  const [ver, ivB, tagB, encB] = String(blob || '').split('.');
  if (ver !== 'v1' || !ivB || !tagB || !encB) throw new Error('Stored token is in an unknown format');
  const key = deriveKey('gmail-refresh-token');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encB, 'base64')), decipher.final()]).toString('utf8');
}

export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb) && String(a ?? '').length > 0;
}

// Signed, expiring OAuth "state" so the callback only accepts flows we started.
export function signState(payload, ttlSeconds = 900) {
  const body = Buffer.from(JSON.stringify({
    ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    n: crypto.randomBytes(8).toString('hex'),
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', deriveKey('oauth-state')).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyState(state) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', deriveKey('oauth-state')).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch { return null; }
}
