import { env } from './config.js';
import { safeEqual } from './crypto.js';

// Raw request body (needed to check Whop's signature byte for byte).
// Vercel buffers the body and replays it to 'data'/'end' listeners.
export function readRawBody(req) {
  return new Promise((resolve, reject) => {
    if (typeof req.rawBody === 'string') return resolve(req.rawBody);
    if (Buffer.isBuffer(req.rawBody)) return resolve(req.rawBody.toString('utf8'));
    const chunks = [];
    req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const raw = typeof req.body === 'string' ? req.body : await readRawBody(req);
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function isCron(req) {
  const secret = env('CRON_SECRET');
  return !!secret && safeEqual(req.headers.authorization || '', `Bearer ${secret}`);
}

export async function isAdmin(req) {
  const pass = env('DASHBOARD_ADMIN_PASSCODE');
  if (!pass) return false;
  const ok = safeEqual(req.headers['x-admin-passcode'] || '', pass);
  if (!ok) await new Promise(r => setTimeout(r, 600)); // slow down guessing
  return ok;
}
