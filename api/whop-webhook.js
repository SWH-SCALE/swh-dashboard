// /api/whop-webhook : Whop calls this when a payment succeeds.
//
// 1. Signature checked (WHOP_WEBHOOK_SECRET). Anything unsigned is rejected.
// 2. Each delivery ID is processed once; repeats are acknowledged and ignored.
// 3. Only payment.succeeded counts. Clicking a link or a pending/failed
//    payment never marks anything paid.
// 4. The payment is matched to an instalment, written to the append-only
//    ledger (Whop payment ID is unique), the instalment is updated, and its
//    reminders stop automatically.

import { env } from './_lib/config.js';
import { createStore } from './_lib/db.js';
import { readRawBody, send } from './_lib/http.js';
import { verifyWebhook, recordWhopPayment } from './_lib/whop.js';

export async function handleWhopWebhook({ store, rawBody, headers, secret, nowSec }) {
  const v = verifyWebhook(rawBody, headers, secret, nowSec);
  if (!v.ok) {
    await store.log({ level: 'warn', event: 'webhook_rejected', message: `Rejected a Whop webhook: ${v.reason}.` });
    return { status: 401, body: { ok: false, error: 'invalid signature' } };
  }

  let event;
  try { event = JSON.parse(rawBody); } catch { return { status: 400, body: { ok: false, error: 'invalid JSON' } }; }
  const type = event.type || event.action || null;

  const claim = await store.claimWebhook(v.id, type, event);
  if (!claim.claimed) {
    if (claim.status === 'processing') return { status: 409, body: { ok: false, error: 'already processing, retry later' } };
    return { status: 200, body: { ok: true, duplicate: true } };
  }

  if (type !== 'payment.succeeded') {
    await store.finishWebhook(v.id, 'ignored');
    return { status: 200, body: { ok: true, ignored: type } };
  }

  try {
    const result = await recordWhopPayment(store, event.data || {});
    await store.finishWebhook(v.id, result.outcome === 'ignored' ? 'ignored' : 'processed');
    return { status: 200, body: { ok: true, ...result } };
  } catch (e) {
    await store.finishWebhook(v.id, 'error', e.message);
    await store.log({ level: 'error', event: 'webhook_error', message: `Whop payment webhook failed and will be retried by Whop: ${e.message}` });
    return { status: 500, body: { ok: false, error: 'processing failed, will retry' } };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  try {
    const rawBody = await readRawBody(req);
    const out = await handleWhopWebhook({ store: createStore(), rawBody, headers: req.headers, secret: env('WHOP_WEBHOOK_SECRET') });
    return send(res, out.status, out.body);
  } catch (e) {
    console.error('whop-webhook error', e);
    return send(res, 500, { ok: false, error: 'server error' });
  }
}
