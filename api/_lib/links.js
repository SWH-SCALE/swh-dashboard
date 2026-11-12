// Automatic Whop checkout links, one per instalment.
//
// How it works (Whop "checkout configuration" API):
//  - A one-time ("one_time") hidden plan is created inline for the exact
//    amount still due, in USD, under an EXISTING product you choose
//    (WHOP_INSTALMENT_PRODUCT_ID). No products, subscriptions or recurring
//    billing are ever created.
//  - Stock is 1, so each link can be paid once.
//  - The instalment and client IDs ride along as metadata, which Whop copies
//    onto the payment, so the webhook matches the payment exactly.
//  - A link is reused while the amount due is unchanged. If the amount
//    changes (partial payment) a new link is made and the old one deleted.
//  - After the instalment is paid, its link is deleted in Whop so it can't be
//    paid twice.
// Nobody is charged until they complete checkout themselves.

import crypto from 'node:crypto';
import { env, whopLinkConfig, WHOP_COMPANY_ID, AMOUNT_TOLERANCE } from './config.js';
import { round2 } from './engine.js';

const API = 'https://api.whop.com/api/v1';

export class LinkError extends Error {}

function absoluteUrl(u) {
  if (!u) return null;
  if (/^https:\/\//.test(u)) return u;
  if (u.startsWith('/')) return `https://whop.com${u}`;
  return null;
}

function planTitle(client, inst) {
  const name = String(client?.name || 'Client').replace(/[^\p{L}\p{N} .,'&/-]/gu, '').slice(0, 40);
  return `Instalment ${inst.installment_number ?? ''} · ${name}`.trim();
}

/**
 * Create a checkout link in Whop. Returns { id, url, planId, amount, currency }.
 */
export async function createCheckoutLink({ inst, client, amount, generation, productId, fetchImpl = fetch }) {
  const key = env('WHOP_API_KEY');
  if (!key) throw new LinkError('WHOP_API_KEY is not set');
  amount = round2(amount);
  if (!(amount > 0)) throw new LinkError('Nothing is due on this instalment');

  const metadata = { instalment_id: String(inst.id), client_id: String(inst.client_id), source: 'swh-dashboard' };
  const title = planTitle(client, inst);
  const notes = `SWH dashboard: instalment ${inst.id} for ${client?.name || 'client'}`;
  const idem = `swh-inst-${inst.id}-${Math.round(amount * 100)}-g${generation}`;

  // Whop's documented shape (plan + company_id). If this account is on the
  // newer API shape (variant + account_id), fall back to that.
  const shapes = [
    { key: idem, body: {
      plan: {
        company_id: WHOP_COMPANY_ID, product_id: productId, currency: 'usd',
        plan_type: 'one_time', initial_price: amount, visibility: 'hidden', stock: 1,
        title, internal_notes: notes, force_create_new_plan: true,
      },
      metadata,
    } },
    { key: idem + '-v', body: {
      account_id: WHOP_COMPANY_ID,
      variant: {
        product_id: productId, currency: 'usd', billing_type: 'one_time', initial_price: amount,
        visibility: 'hidden', stock: 1, unlimited_stock: false, title, force_create_new_plan: true,
      },
      metadata,
    } },
  ];

  let lastErr = null;
  for (const shape of shapes) {
    let r, data;
    try {
      r = await fetchImpl(`${API}/checkout_configurations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': shape.key },
        body: JSON.stringify(shape.body),
        signal: AbortSignal.timeout(15000),
      });
      data = await r.json().catch(() => ({}));
    } catch (e) {
      throw new LinkError(`Could not reach Whop: ${e.message}`);
    }
    if (r.ok) {
      const plan = data.plan || data.variant || {};
      const url = absoluteUrl(data.purchase_url);
      if (!data.id || !url) throw new LinkError('Whop did not return a checkout link');
      // Verify what Whop actually created before anyone gets the link
      const gotPrice = plan.initial_price ?? plan.initial_price_due?.amount;
      const gotCur = String(plan.currency || data.currency || 'usd').toLowerCase();
      const badPrice = gotPrice != null && Math.abs(Number(gotPrice) - amount) > 0.01;
      const badCur = gotCur !== 'usd';
      const badType = (plan.plan_type || plan.billing_type) && (plan.plan_type || plan.billing_type) !== 'one_time';
      if (badPrice || badCur || badType) {
        await deleteCheckoutLink(data.id, { fetchImpl }).catch(() => {});
        throw new LinkError(`Whop created a link that doesn't match (price ${gotPrice} ${gotCur}, type ${plan.plan_type || plan.billing_type}). It was deleted.`);
      }
      return { id: data.id, url, planId: plan.id || null, amount, currency: 'usd' };
    }
    const msg = data?.error?.message || data?.message || `HTTP ${r.status}`;
    lastErr = new LinkError(r.status === 401 || r.status === 403
      ? `Whop refused (${msg}). The API key needs checkout and plan permissions.`
      : `Whop could not create the link: ${msg}`);
    if (!(r.status === 400 || r.status === 422)) break; // only a shape problem is worth the second attempt
  }
  throw lastErr;
}

export async function deleteCheckoutLink(id, { fetchImpl = fetch } = {}) {
  const key = env('WHOP_API_KEY');
  if (!key || !id) return false;
  const r = await fetchImpl(`${API}/checkout_configurations/${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000),
  });
  if (r.ok || r.status === 404) return true;
  throw new LinkError(`Whop delete failed (${r.status})`);
}

/**
 * Make sure an instalment has a working link for exactly `amountDue`.
 * Reuses the current generated link when the amount is unchanged.
 * opts.replaceManual: replace a pasted (manual) link too.
 */
export async function ensureLink(store, { inst, client, amountDue, replaceManual = false, fetchImpl = fetch }) {
  const cfg = whopLinkConfig();
  if (!cfg.enabled) throw new LinkError(cfg.reason);
  amountDue = round2(amountDue);
  if (!(amountDue > AMOUNT_TOLERANCE)) throw new LinkError('Nothing is due on this instalment');

  const lockName = `whop-link:${inst.id}`;
  const holder = crypto.randomUUID();
  if (!(await store.claimLock(lockName, holder, 60))) throw new LinkError('A link for this instalment is being created right now. Try again in a minute.');
  try {
    const existing = await store.getLink(String(inst.id));
    if (existing && existing.source !== 'generated' && !replaceManual) {
      return { link: existing, created: false };
    }
    if (existing && existing.source === 'generated' && !existing.retired_at &&
        Math.abs(Number(existing.verified_amount) - amountDue) <= 0.009 &&
        String(existing.verified_currency || 'usd') === 'usd') {
      return { link: existing, created: false };
    }

    const generation = (existing?.generation || 0) + 1;
    const made = await createCheckoutLink({ inst, client, amount: amountDue, generation, productId: cfg.productId, fetchImpl });
    const link = await store.upsertLink({
      instalment_id: String(inst.id), client_id: String(inst.client_id), url: made.url, plan_id: made.planId,
      verify_status: 'verified', verified_amount: made.amount, verified_currency: 'usd', verify_note: null,
      verified_at: new Date().toISOString(), source: 'generated', checkout_config_id: made.id,
      generation, retired_at: null,
    });

    // Switch off the previous generated link so the old amount can't be paid
    if (existing?.source === 'generated' && existing.checkout_config_id && !existing.retired_at) {
      try { await deleteCheckoutLink(existing.checkout_config_id, { fetchImpl }); }
      catch (e) { await store.log({ level: 'warn', event: 'link_cleanup_failed', client_id: String(inst.client_id), instalment_id: String(inst.id), message: `Old Whop link could not be switched off: ${e.message}` }); }
    }
    await store.log({
      event: 'link_generated', client_id: String(inst.client_id), instalment_id: String(inst.id),
      message: `${existing ? 'New' : 'Created'} Whop link for ${client?.name || 'client'} instalment #${inst.installment_number}: $${made.amount} USD, one-time, single use.`,
      details: { checkout_config_id: made.id, plan_id: made.planId },
    });
    return { link, created: true, replaced: !!existing };
  } finally {
    await store.releaseLock(lockName, holder).catch(() => {});
  }
}

/** Delete a generated link in Whop once its instalment is settled. Best effort. */
export async function retireLink(store, instalmentId, { fetchImpl = fetch, reason = 'paid' } = {}) {
  const link = await store.getLink(String(instalmentId));
  if (!link || link.source !== 'generated' || link.retired_at || !link.checkout_config_id) return false;
  try {
    await deleteCheckoutLink(link.checkout_config_id, { fetchImpl });
    await store.upsertLink({ instalment_id: String(instalmentId), client_id: link.client_id, url: link.url, retired_at: new Date().toISOString() });
    return true;
  } catch (e) {
    await store.log({ level: 'warn', event: 'link_cleanup_failed', client_id: link.client_id, instalment_id: String(instalmentId), message: `Whop link for a ${reason} instalment could not be switched off yet (${e.message}). Will retry on the next daily run.` });
    return false;
  }
}

