// /api/whop-retainer-sync.js
// Pulls payments from BOTH Whop products — the Ads product and the Organic
// product — and upserts one row per payment into the Supabase
// `retainer_payments` table.
//
// Runs automatically every day via Vercel cron (see vercel.json), and also on
// a manual GET to /api/whop-retainer-sync (the "↻ Sync Whop" button on the
// Retainers tab).
//
// This sync is intentionally a near-copy of /api/whop-sync.js so it uses the
// exact same, already-working Whop API call style, auth and pagination.
//
// IMPORTANT — this pulls EVERY payment on both products, not just retainers.
// Whop has no way to know whether a payment is a retainer or a one-off
// high-ticket sale. So every payment lands in `retainer_payments` with
// is_retainer = false. In the dashboard, Salima taps "Mark retainer" on the
// real retainer payments; only those feed the 30/60-day forecast.
//
// Each run pulls the FULL payment history for both products, so the data
// self-heals: re-running never duplicates (whop_payment_id is unique) and
// the upsert is set to PRESERVE is_retainer / amount_2 / amount_3 — the
// columns Salima edits — so a sync never wipes her input.

const WHOP_KEY     = process.env.WHOP_API_KEY;
const SUPABASE_URL = 'https://qstlyvauppjkdiwpgtql.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

// ---- CONFIG ----------------------------------------------------------------
// Whop company id (not secret).
const WHOP_COMPANY_ID = 'biz_6YYccxU9EzDgfU';

// The two products. Every payment is tagged with the source of its product.
const ADS_PRODUCT_ID     = 'prod_k8RgabvSAsdw7';
const ORGANIC_PRODUCT_ID = 'prod_AzWpEK5OT8bT8';

// Map each product id to the source label written into retainer_payments.
const PRODUCT_SOURCE = {
  [ADS_PRODUCT_ID]:     'ads',
  [ORGANIC_PRODUCT_ID]: 'organic',
};
// ----------------------------------------------------------------------------

// Pull the full, paginated payment history for ONE product from Whop.
async function fetchProductPayments(productId) {
  let url = `https://api.whop.com/api/v1/payments`
    + `?company_id=${WHOP_COMPANY_ID}`
    + `&product_ids=${productId}`
    + `&first=100`;

  const payments = [];
  let pages = 0;

  while (url && pages < 50) {
    const whopRes  = await fetch(url, {
      headers: { 'Authorization': `Bearer ${WHOP_KEY}` },
    });
    const whopJson = await whopRes.json();

    if (whopJson.error) {
      // bubble the error up with which product/page it happened on
      const err = new Error(typeof whopJson.error === 'string'
        ? whopJson.error : JSON.stringify(whopJson.error));
      err.stage = 'whop';
      err.productId = productId;
      err.page = pages;
      throw err;
    }

    (whopJson.data || []).forEach(p => payments.push(p));

    const nextCursor =
      whopJson.pagination && (whopJson.pagination.next_cursor || whopJson.pagination.end_cursor);
    const hasNext =
      whopJson.pagination && whopJson.pagination.has_next_page;

    if (hasNext && nextCursor) {
      url = `https://api.whop.com/api/v1/payments`
        + `?company_id=${WHOP_COMPANY_ID}`
        + `&product_ids=${productId}`
        + `&first=100`
        + `&after=${encodeURIComponent(nextCursor)}`;
    } else {
      url = null;
    }
    pages++;
  }

  return { payments, pages };
}

export default async function handler(req, res) {
  // --- guard: required config ---
  if (!WHOP_KEY)     return res.status(500).json({ ok: false, error: 'WHOP_API_KEY not set' });
  if (!SUPABASE_KEY) return res.status(500).json({ ok: false, error: 'SUPABASE_ANON_KEY not set' });

  try {
    // --- 1. pull payments for BOTH products from Whop ---
    let allPayments = [];   // { payment, source }
    let totalPages  = 0;
    const seenCount = {};

    for (const productId of [ADS_PRODUCT_ID, ORGANIC_PRODUCT_ID]) {
      let result;
      try {
        result = await fetchProductPayments(productId);
      } catch (e) {
        return res.status(502).json({
          ok: false, stage: 'whop', productId: e.productId || productId,
          page: e.page, error: e.message,
        });
      }
      const source = PRODUCT_SOURCE[productId];
      seenCount[source] = result.payments.length;
      totalPages += result.pages;
      result.payments.forEach(p => allPayments.push({ payment: p, source }));
    }

    if (allPayments.length === 0) {
      return res.status(200).json({
        ok: true,
        message: 'No payments returned from Whop for either product yet',
        paymentsWritten: 0,
      });
    }

    // --- 2. keep only successfully-paid payments, build upsert payload ---
    // status 'paid' / substatus 'succeeded' = real collected money.
    const paid = allPayments.filter(({ payment: p }) =>
      p && (p.status === 'paid' || p.substatus === 'succeeded')
    );

    const payload = paid.map(({ payment: p, source }) => ({
      whop_payment_id: p.id,
      // user.name is often null on Whop; billing_address.name is reliable.
      customer_name:   (p.billing_address && p.billing_address.name)
                         || (p.user && p.user.name)
                         || null,
      customer_email:  (p.user && p.user.email) || null,
      amount_gross:    +(((p.usd_total != null ? p.usd_total : p.total) || 0).toFixed(2)),
      amount_net:      p.amount_after_fees != null
                         ? +(p.amount_after_fees.toFixed(2))
                         : null,
      currency:        (p.currency || 'usd').toUpperCase(),
      source:          source,                      // 'ads' or 'organic'
      product_id:      source === 'ads' ? ADS_PRODUCT_ID : ORGANIC_PRODUCT_ID,
      paid_at:         p.paid_at || p.created_at || null,
      synced_at:       new Date().toISOString(),
      // NOTE: is_retainer / amount_2 / amount_3 are deliberately NOT sent.
      // They are owned by Salima in the dashboard. Omitting them from the
      // upsert means merge-duplicates leaves any existing values untouched,
      // and new rows fall back to the table default (is_retainer = false).
    }));

    // sort newest-first so the summary reads naturally
    payload.sort((a, b) => String(b.paid_at).localeCompare(String(a.paid_at)));

    // --- 3. upsert into Supabase ---
    // on_conflict=whop_payment_id + merge-duplicates => re-running overwrites
    // the synced columns of an existing payment but, because is_retainer /
    // amount_2 / amount_3 are not in the payload, those are preserved.
    const upsertRes = await fetch(
      `${SUPABASE_URL}/rest/v1/retainer_payments?on_conflict=whop_payment_id`,
      {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(payload),
      }
    );

    if (!upsertRes.ok) {
      const errText = await upsertRes.text();
      return res.status(502).json({
        ok: false,
        stage: 'supabase',
        status: upsertRes.status,
        error: errText,
      });
    }

    // --- 4. summary ---
    const totalGross = payload.reduce((s, p) => s + (p.amount_gross || 0), 0);
    return res.status(200).json({
      ok: true,
      paymentsWritten: payload.length,
      totalGrossUsd: +totalGross.toFixed(2),
      whopPaymentsSeen: {
        ads:     seenCount.ads     || 0,
        organic: seenCount.organic || 0,
      },
      whopPagesFetched: totalPages,
    });

  } catch (e) {
    return res.status(500).json({ ok: false, stage: 'exception', error: e.message });
  }
}
