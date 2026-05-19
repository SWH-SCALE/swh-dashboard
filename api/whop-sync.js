// /api/whop-sync.js
// Pulls ALL payments from the Whop API and logs each one into the Supabase
// `deals` table — the Sales & Revenue source of truth that powers the
// Executive Dashboard's high-ticket revenue figures.
//
// Rules (kept deliberately simple):
//   1. Pull every Whop payment for the company.
//   2. EXCLUDE the low-ticket product (LT_PRODUCT_IDS) — those are $27 LT
//      purchases, not high-ticket sales, and must not hit `deals`.
//   3. Every remaining payment is logged as a deal with source = 'ads'.
//      (Source can be manually switched to 'organic' in the Sales & Revenue
//      tab; this sync never overwrites an existing row.)
//   4. Idempotent: each Whop payment carries a unique whop_payment_id. A
//      payment already present in `deals` is skipped, so the daily cron
//      never double-logs revenue. Every DISTINCT payment = one deal row,
//      even if the same client pays multiple times (intentional).
//
// Runs daily via Vercel cron and on a manual GET to /api/whop-sync.

const WHOP_KEY     = process.env.WHOP_API_KEY;
const SUPABASE_URL = 'https://qstlyvauppjkdiwpgtql.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const WHOP_COMPANY_ID = 'biz_6YYccxU9EzDgfU';

// Low-ticket product(s) to EXCLUDE — these are not high-ticket revenue.
// "Turn Content In To Clients" ($27 LT course).
const LT_PRODUCT_IDS = ['prod_Q0nZad1rnebtx'];

// Pull the product id off a Whop payment, wherever Whop puts it.
function productIdOf(p) {
  return (p && (
    p.product_id ||
    (p.product && p.product.id) ||
    (p.plan && p.plan.product && p.plan.product.id) ||
    (p.plan && p.plan.product_id)
  )) || null;
}

export default async function handler(req, res) {
  if (!WHOP_KEY)     return res.status(500).json({ ok: false, error: 'WHOP_API_KEY not set' });
  if (!SUPABASE_KEY) return res.status(500).json({ ok: false, error: 'SUPABASE_ANON_KEY not set' });

  try {
    // --- 1. pull ALL payments from Whop (no product filter), following pagination ---
    const buildUrl = (cursor) =>
      `https://api.whop.com/api/v1/payments`
      + `?company_id=${WHOP_COMPANY_ID}`
      + `&first=100`
      + (cursor ? `&after=${encodeURIComponent(cursor)}` : '');

    let url = buildUrl(null);
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

      const nextCursor =
        whopJson.pagination && (whopJson.pagination.next_cursor || whopJson.pagination.end_cursor);
      const hasNext =
        whopJson.pagination && whopJson.pagination.has_next_page;

      url = (hasNext && nextCursor) ? buildUrl(nextCursor) : null;
      pages++;
    }

    if (payments.length === 0) {
      return res.status(200).json({ ok: true, message: 'No payments returned from Whop', dealsWritten: 0 });
    }

    // --- 2. keep paid/succeeded, drop low-ticket product ---
    const paid = payments.filter(p =>
      p && (p.status === 'paid' || p.substatus === 'succeeded')
    );
    const ltSkipped = paid.filter(p => LT_PRODUCT_IDS.includes(productIdOf(p))).length;
    const htPayments = paid.filter(p => !LT_PRODUCT_IDS.includes(productIdOf(p)));

    if (htPayments.length === 0) {
      return res.status(200).json({
        ok: true, message: 'No high-ticket payments to log (all were low-ticket or unpaid)',
        dealsWritten: 0, ltSkipped,
      });
    }

    // --- 3. find which Whop payments are already in `deals` (idempotency) ---
    const ids = htPayments.map(p => p.id).filter(Boolean);
    const existing = new Set();
    // query in chunks so the URL never gets too long
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const inList = chunk.map(id => `"${id}"`).join(',');
      const checkRes = await fetch(
        `${SUPABASE_URL}/rest/v1/deals?select=whop_payment_id&whop_payment_id=in.(${inList})`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      if (checkRes.ok) {
        const rows = await checkRes.json();
        rows.forEach(r => { if (r.whop_payment_id) existing.add(r.whop_payment_id); });
      }
    }

    // --- 4. build deal rows for payments not already logged ---
    const seen = new Set(); // guard against the same id appearing twice in one pull
    const newRows = [];
    for (const p of htPayments) {
      if (!p.id || existing.has(p.id) || seen.has(p.id)) continue;
      seen.add(p.id);

      const gross = +(((p.usd_total != null ? p.usd_total : p.total) || 0).toFixed(2));
      const paidAt = p.paid_at || p.created_at || null;
      const dateOnly = paidAt ? String(paidAt).split('T')[0] : null;

      newRows.push({
        name:    (p.billing_address && p.billing_address.name)
                   || (p.user && p.user.name) || null,
        email:   (p.user && p.user.email) || null,
        date:    dateOnly,
        usd:     gross,
        contract: 0,
        source:  'ads',                       // default; manually switchable to 'organic'
        closer:  null,
        setter:  null,
        notes:   'Auto-synced from Whop',
        whop_payment_id: p.id,
      });
    }

    if (newRows.length === 0) {
      return res.status(200).json({
        ok: true, message: 'All Whop payments already logged — nothing new',
        dealsWritten: 0, ltSkipped, alreadyLogged: existing.size,
      });
    }

    // --- 5. insert the new deals ---
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/deals`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(newRows),
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      return res.status(502).json({ ok: false, stage: 'supabase', status: insertRes.status, error: errText });
    }

    const totalGross = newRows.reduce((s, r) => s + (r.usd || 0), 0);
    return res.status(200).json({
      ok: true,
      dealsWritten: newRows.length,
      totalGrossUsd: +totalGross.toFixed(2),
      ltSkipped,
      alreadyLogged: existing.size,
      whopPaymentsSeen: payments.length,
      whopPagesFetched: pages,
    });

  } catch (e) {
    return res.status(500).json({ ok: false, stage: 'exception', error: e.message });
  }
}
