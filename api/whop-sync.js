// /api/whop-sync.js
// Pulls high-ticket ADS sales from the Whop API and upserts one row per
// payment into the Supabase `ht_sales` table.
//
// Runs automatically every day via Vercel cron (see vercel.json),
// and also on a manual GET to /api/whop-sync.
//
// Each run pulls the FULL payment history for the ads product, so the data
// self-heals: re-running never duplicates (the Whop payment id is the
// primary key) and any late changes get corrected.

const WHOP_KEY     = process.env.WHOP_API_KEY;
const SUPABASE_URL = 'https://qstlyvauppjkdiwpgtql.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

// ---- CONFIG ----------------------------------------------------------------
// Whop company id (not secret).
const WHOP_COMPANY_ID = 'biz_6YYccxU9EzDgfU';

// The ADS high-ticket product. Every payment on this product is an ads sale.
// (The organic HT product is intentionally NOT tracked here.)
const ADS_PRODUCT_ID = 'prod_k8RgabvSAsdw7';
// ----------------------------------------------------------------------------

export default async function handler(req, res) {
  // --- guard: required config ---
  if (!WHOP_KEY)     return res.status(500).json({ ok: false, error: 'WHOP_API_KEY not set' });
  if (!SUPABASE_KEY) return res.status(500).json({ ok: false, error: 'SUPABASE_ANON_KEY not set' });

  try {
    // --- 1. pull payments for the ads product from Whop, following pagination ---
    let url = `https://api.whop.com/api/v1/payments`
      + `?company_id=${WHOP_COMPANY_ID}`
      + `&product_ids=${ADS_PRODUCT_ID}`
      + `&first=100`;

    const payments = [];
    let pages = 0;

    while (url && pages < 50) {
      const whopRes = await fetch(url, {
        headers: { 'Authorization': `Bearer ${WHOP_KEY}` },
      });
      const whopJson = await whopRes.json();

      if (whopJson.error) {
        return res.status(502).json({ ok: false, stage: 'whop', page: pages, error: whopJson.error });
      }

      (whopJson.data || []).forEach(p => payments.push(p));

      // follow the next-page cursor if Whop split the result across pages
      const nextCursor =
        whopJson.pagination && (whopJson.pagination.next_cursor || whopJson.pagination.end_cursor);
      const hasNext =
        whopJson.pagination && whopJson.pagination.has_next_page;

      if (hasNext && nextCursor) {
        url = `https://api.whop.com/api/v1/payments`
          + `?company_id=${WHOP_COMPANY_ID}`
          + `&product_ids=${ADS_PRODUCT_ID}`
          + `&first=100`
          + `&after=${encodeURIComponent(nextCursor)}`;
      } else {
        url = null;
      }
      pages++;
    }

    if (payments.length === 0) {
      return res.status(200).json({
        ok: true,
        message: 'No payments returned from Whop for the ads product yet',
        salesWritten: 0,
      });
    }

    // --- 2. keep only successfully-paid payments, build upsert payload ---
    // status 'paid' / substatus 'succeeded' = real collected money.
    const paid = payments.filter(p =>
      p && (p.status === 'paid' || p.substatus === 'succeeded')
    );

    const payload = paid.map(p => ({
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
      source:          'ads',                       // this product = ads, always
      product_id:      ADS_PRODUCT_ID,
      paid_at:         p.paid_at || p.created_at || null,
      synced_at:       new Date().toISOString(),
    }));

    // sort newest-first so the summary reads naturally
    payload.sort((a, b) => String(b.paid_at).localeCompare(String(a.paid_at)));

    // --- 3. upsert into Supabase ---
    // on_conflict=whop_payment_id + merge-duplicates => re-running overwrites
    // the same payment instead of inserting a duplicate. Safe to run any time.
    const upsertRes = await fetch(
      `${SUPABASE_URL}/rest/v1/ht_sales?on_conflict=whop_payment_id`,
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
      salesWritten: payload.length,
      totalGrossUsd: +totalGross.toFixed(2),
      whopPaymentsSeen: payments.length,
      whopPagesFetched: pages,
    });

  } catch (e) {
    return res.status(500).json({ ok: false, stage: 'exception', error: e.message });
  }
}
