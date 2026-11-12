// Whop: webhook signature check, payment matching, link verification.

import crypto from 'node:crypto';
import { env, WHOP_COMPANY_ID, LT_PRODUCT_IDS, LT_AMOUNTS, AMOUNT_TOLERANCE, settings } from './config.js';
import { round2, extractPlanId, isWhopUrl } from './engine.js';
import { todayIn } from './dates.js';

// ── Signature (Standard Webhooks: HMAC-SHA256 over "id.timestamp.body") ──
export function verifyWebhook(rawBody, headers, secret, nowSec = Math.floor(Date.now() / 1000)) {
  const id = headers['webhook-id'];
  const ts = headers['webhook-timestamp'];
  const sigHeader = headers['webhook-signature'];
  if (!secret) return { ok: false, reason: 'WHOP_WEBHOOK_SECRET not set' };
  if (!id || !ts || !sigHeader || !/^\d+$/.test(ts)) return { ok: false, reason: 'Missing signature headers' };
  if (Math.abs(nowSec - Number(ts)) > 300) return { ok: false, reason: 'Timestamp outside 5 minute window' };

  const signed = `${id}.${ts}.${rawBody}`;
  // Whop's secret is used exactly as issued (ws_...). Also accept the
  // generic Standard Webhooks form (base64 after the prefix) to be safe.
  const keys = [Buffer.from(secret, 'utf8')];
  const after = secret.includes('_') ? secret.slice(secret.indexOf('_') + 1) : secret;
  try { const b = Buffer.from(after, 'base64'); if (b.length >= 16) keys.push(b); } catch { /* ignore */ }

  const provided = String(sigHeader).split(' ').map(p => p.split(',')).filter(p => p[0] === 'v1').map(p => p[1]);
  for (const key of keys) {
    const expected = crypto.createHmac('sha256', key).update(signed).digest('base64');
    for (const sig of provided) {
      const a = Buffer.from(sig || ''); const b = Buffer.from(expected);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { ok: true, id };
    }
  }
  return { ok: false, reason: 'Signature does not match' };
}

// ── Normalise a Whop payment object ──
export function normalisePayment(p) {
  const currency = String(p.currency || 'usd').toLowerCase();
  const amount = round2(p.usd_total ?? (currency === 'usd' ? (p.total ?? p.final_amount ?? p.subtotal) : null) ?? 0);
  return {
    id: p.id,
    status: p.status || null,
    substatus: p.substatus || null,
    amount,
    currency,
    paidAt: p.paid_at || p.created_at || new Date().toISOString(),
    email: (p.user?.email || p.email || p.customer_email || '').trim().toLowerCase() || null,
    name: (p.billing_address?.name || p.user?.name || p.user?.username || '').trim() || null,
    planId: p.plan?.id || p.plan_id || null,
    productId: p.product?.id || p.product_id || p.plan?.product?.id || null,
    metadata: p.metadata || p.checkout_configuration?.metadata || {},
  };
}

export function isSucceeded(pay) {
  if (!pay.status && !pay.substatus) return true; // event type already says succeeded
  return pay.status === 'paid' || pay.substatus === 'succeeded';
}

export function isNeverInstalment(pay) {
  return LT_PRODUCT_IDS.includes(pay.productId) || LT_AMOUNTS.includes(Math.round(pay.amount));
}

/**
 * Decide which instalment a payment belongs to. Pure function.
 * Auto-applies only when certain; otherwise returns { review: reason }.
 * data: output of store.loadAll()
 */
export function matchPayment(pay, data) {
  const clients = new Map(data.clients.map(c => [String(c.id), c]));
  const owedOf = inst => round2(Number(inst.amount_usd) - (data.paidByInstalment[String(inst.id)] || 0));
  const unpaid = data.instalments.filter(i => i.paid !== true && owedOf(i) > AMOUNT_TOLERANCE);
  const emailsOf = cid => {
    const c = clients.get(String(cid)) || {};
    const s = data.settings[String(cid)] || {};
    return [c.email, s.reminder_email].filter(Boolean).map(e => e.trim().toLowerCase());
  };
  const byDue = (a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999'));

  // 1. Instalment ID carried in checkout metadata
  const metaId = pay.metadata?.instalment_id;
  if (metaId) {
    const inst = data.instalments.find(i => String(i.id) === String(metaId));
    if (inst) return { instalment: inst, method: 'metadata' };
  }

  // 2. The Whop plan behind a saved link
  if (pay.planId) {
    const linked = Object.values(data.links).filter(l => l.plan_id === pay.planId).map(l => String(l.instalment_id));
    const candidates = unpaid.filter(i => linked.includes(String(i.id)));
    if (candidates.length === 1) {
      const inst = candidates[0];
      const emails = emailsOf(inst.client_id);
      if (linked.length === 1 || (pay.email && emails.includes(pay.email))) return { instalment: inst, method: 'whop_link' };
    } else if (candidates.length > 1 && pay.email) {
      const mine = candidates.filter(i => emailsOf(i.client_id).includes(pay.email)).sort(byDue);
      if (mine.length >= 1 && new Set(mine.map(i => String(i.client_id))).size === 1) return { instalment: mine[0], method: 'whop_link+email' };
    }
  }

  // 3. Payer email + exact amount of an unpaid instalment
  if (!pay.email) return { review: 'No payer email on the payment' };
  const clientIds = [...new Set(data.clients.filter(c => emailsOf(c.id).includes(pay.email)).map(c => String(c.id)))];
  if (clientIds.length === 0) return { review: 'No retainer client with this email' };
  if (clientIds.length > 1) return { review: 'More than one client has this email' };
  const exact = unpaid
    .filter(i => String(i.client_id) === clientIds[0] && Math.abs(owedOf(i) - pay.amount) <= AMOUNT_TOLERANCE)
    .sort(byDue);
  if (exact.length) return { instalment: exact[0], method: 'email+amount' };
  return { review: `Client found, but no unpaid instalment of $${pay.amount}` };
}

/**
 * Record a confirmed Whop payment. Idempotent: the same payment twice is a no-op.
 * Returns { outcome: 'applied'|'partial'|'duplicate'|'review'|'ignored', ... }
 */
export async function recordWhopPayment(store, raw, { dataOverride } = {}) {
  const pay = normalisePayment(raw);
  if (!pay.id) return { outcome: 'ignored', reason: 'No payment id' };
  if (!isSucceeded(pay)) return { outcome: 'ignored', reason: `Status ${pay.status}/${pay.substatus}` };
  if (isNeverInstalment(pay)) return { outcome: 'ignored', reason: 'Low-ticket product, not an instalment' };

  const data = dataOverride || await store.loadAll();
  const already = await store.paymentsByWhopIds([pay.id]);
  if (already.length) {
    // Already in the ledger (duplicate delivery). Make sure the instalment reflects it.
    await store.applyLedger(already[0].instalment_id, todayIn(settings().timezone, new Date(pay.paidAt)));
    return { outcome: 'duplicate', instalment_id: already[0].instalment_id };
  }

  if (pay.currency !== 'usd' && raw.usd_total == null) {
    await store.addReview(reviewRow(pay, `Paid in ${pay.currency.toUpperCase()}, needs manual check`));
    await store.log({ level: 'warn', event: 'payment_review', message: `Whop payment ${pay.id} (${pay.currency.toUpperCase()}) from ${pay.email || 'unknown'} needs review.` });
    return { outcome: 'review' };
  }

  const m = matchPayment(pay, data);
  if (m.review) {
    await store.addReview(reviewRow(pay, m.review));
    await store.log({ level: 'warn', event: 'payment_review', message: `Whop payment of $${pay.amount} from ${pay.email || 'unknown'} could not be matched automatically: ${m.review}. Review it on the Retainers tab.`, details: { whop_payment_id: pay.id } });
    return { outcome: 'review', reason: m.review };
  }
  return applyPayment(store, data, pay, m.instalment, m.method);
}

export async function applyPayment(store, data, pay, inst, method) {
  const row = await store.insertPayment({
    instalment_id: String(inst.id), client_id: String(inst.client_id), source: 'whop',
    whop_payment_id: pay.id, amount_usd: pay.amount, currency: pay.currency,
    paid_at: pay.paidAt, match_method: method, payer_email: pay.email,
  });
  const paidDate = todayIn(settings().timezone, new Date(pay.paidAt));
  if (!row) {
    await store.applyLedger(inst.id, paidDate);
    return { outcome: 'duplicate', instalment_id: String(inst.id) };
  }
  const res = await store.applyLedger(inst.id, paidDate);
  const client = data.clients.find(c => String(c.id) === String(inst.client_id)) || {};
  const over = res.sum - res.total;
  await store.log({
    level: over > AMOUNT_TOLERANCE ? 'warn' : 'info',
    event: res.covered ? 'payment_confirmed' : 'payment_partial',
    client_id: String(inst.client_id), instalment_id: String(inst.id),
    message: res.covered
      ? `Payment confirmed: ${client.name || 'client'} paid $${pay.amount} for instalment #${inst.installment_number}. Marked paid, reminders stopped.${over > AMOUNT_TOLERANCE ? ` Overpaid by $${round2(over)}, check allocation.` : ''}`
      : `Partial payment: ${client.name || 'client'} paid $${pay.amount} towards instalment #${inst.installment_number} ($${round2(res.total - res.sum)} still due).`,
    details: { whop_payment_id: pay.id, match_method: method },
  });
  return { outcome: res.covered ? 'applied' : 'partial', instalment_id: String(inst.id) };
}

function reviewRow(pay, reason) {
  return {
    whop_payment_id: pay.id, reason, amount_usd: pay.amount, currency: pay.currency,
    payer_email: pay.email, payer_name: pay.name, plan_id: pay.planId, product_id: pay.productId, paid_at: pay.paidAt,
  };
}

// ── Link verification: look up the Whop plan behind a pasted link ──
export async function verifyLink(url) {
  if (!isWhopUrl(url)) return { verify_status: 'mismatch', verify_note: 'Link must be an https://whop.com link', plan_id: null };
  const planId = extractPlanId(url);
  if (!planId) return { verify_status: 'unverified', plan_id: null, verify_note: 'No plan ID in the link, so the amount could not be checked automatically' };
  const key = env('WHOP_API_KEY');
  if (!key) return { verify_status: 'unverified', plan_id: planId, verify_note: 'WHOP_API_KEY not set' };
  try {
    const r = await fetch(`https://api.whop.com/api/v1/plans/${encodeURIComponent(planId)}`, {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000),
    });
    const p = await r.json().catch(() => ({}));
    if (!r.ok) return { verify_status: 'unverified', plan_id: planId, verify_note: `Whop lookup failed (${r.status}). Check the amount on the link manually.` };
    const company = p.company?.id || p.company_id || null;
    if (company && company !== WHOP_COMPANY_ID) return { verify_status: 'mismatch', plan_id: planId, verify_note: 'This Whop plan belongs to a different company' };
    return {
      verify_status: 'verified', plan_id: planId,
      verified_amount: round2(p.initial_price ?? p.price ?? 0),
      verified_currency: String(p.currency || 'usd').toLowerCase(),
      verify_note: null, verified_at: new Date().toISOString(),
    };
  } catch (e) {
    return { verify_status: 'unverified', plan_id: planId, verify_note: `Could not reach Whop: ${e.message}` };
  }
}
