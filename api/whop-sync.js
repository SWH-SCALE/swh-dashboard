// /api/whop-sync.js
// Pulls ALL payments from the Whop API and syncs them to TWO Supabase tables:
//
//   1. `deals`              — Executive tab cash-collected (existing behaviour).
//   2. `retainer_payments`  — Retainers tab tracking (NEW).
//
// Rules for `deals` (unchanged from previous version):
//   - Pull every Whop payment for the company.
//   - Exclude low-ticket product + low-ticket upsell amounts.
//   - Every remaining payment is logged as a deal with source = 'ads'.
//   - Idempotent via whop_payment_id.
//
// Rules for retainer system (NEW):
//   - Match client by email (case-insensitive) → fallback to name match.
//   - No match → create new client (setup_complete=false), allocate as deposit.
//   - Existing client + setup complete → allocate to next unpaid installment
//     in sequence (retainer_2 → final_retainer). Amount > $50 below expected
//     → status 'partial' and flagged for review.
//   - Existing client + setup pending → 'unallocated' (defensive).
//   - Idempotent via whop_payment_id UNIQUE constraint.
//
// Failure isolation: retainer-sync errors NEVER block deals-sync. The Executive
// tab keeps working even if the new retainer tables are misconfigured.
//
// Runs daily via Vercel cron and on a manual GET to /api/whop-sync.

const WHOP_KEY     = process.env.WHOP_API_KEY;
const SUPABASE_URL = 'https://qstlyvauppjkdiwpgtql.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const WHOP_COMPANY_ID = 'biz_6YYccxU9EzDgfU';

// Low-ticket product(s) to EXCLUDE — these are not high-ticket revenue.
const LT_PRODUCT_IDS = ['prod_Q0nZad1rnebtx'];

// Low-ticket UPSELL amounts to EXCLUDE.
const LT_UPSELL_AMOUNTS = [97];

// Retainer partial-match tolerance: within $50 = "paid in full".
const PARTIAL_TOLERANCE = 50;

function isLtUpsellAmount(usd) {
  return LT_UPSELL_AMOUNTS.includes(Math.round(Number(usd) || 0));
}

function grossOf(p) {
  return +(((p && (p.usd_total != null ? p.usd_total : p.total)) || 0).toFixed(2));
}

function productIdOf(p) {
  return (p && (
    p.product_id ||
    (p.product && p.product.id) ||
    (p.plan && p.plan.product && p.plan.product.id) ||
    (p.plan && p.plan.product_id)
  )) || null;
}

// ── Supabase REST helpers ──────────────────────────────
const supaHeaders = (extra = {}) => ({
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  ...extra,
});

async function supaSelect(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: supaHeaders() });
  if (!r.ok) throw new Error(`Supabase select ${r.status}: ${await r.text()}`);
  return r.json();
}

async function supaInsertOne(table, row, returnRow = false) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: supaHeaders({ 'Prefer': returnRow ? 'return=representation' : 'return=minimal' }),
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`Supabase insert ${table} ${r.status}: ${await r.text()}`);
  if (returnRow) {
    const arr = await r.json();
    return Array.isArray(arr) ? arr[0] : arr;
  }
}

export default async function handler(req, res) {
  if (!WHOP_KEY)     return res.status(500).json({ ok: false, error: 'WHOP_API_KEY not set' });
  if (!SUPABASE_KEY) return res.status(500).json({ ok: false, error: 'SUPABASE_ANON_KEY not set' });

  try {
    // --- 1. pull ALL payments from Whop (cursor pagination) ---
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

    // --- 2. keep paid/succeeded, drop low-ticket ---
    const paid = payments.filter(p =>
      p && (p.status === 'paid' || p.substatus === 'succeeded')
    );
    const isLowTicket = (p) =>
      LT_PRODUCT_IDS.includes(productIdOf(p)) || isLtUpsellAmount(grossOf(p));

    const ltSkipped   = paid.filter(p => isLowTicket(p)).length;
    const htPayments  = paid.filter(p => !isLowTicket(p));

    if (htPayments.length === 0) {
      return res.status(200).json({
        ok: true, message: 'No high-ticket payments to log (all were low-ticket or unpaid)',
        dealsWritten: 0, ltSkipped,
      });
    }

    // --- 3. find which Whop payments are already in `deals` (idempotency) ---
    const ids = htPayments.map(p => p.id).filter(Boolean);
    const existingDeals = new Set();
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const inList = chunk.map(id => `"${id}"`).join(',');
      const checkRes = await fetch(
        `${SUPABASE_URL}/rest/v1/deals?select=whop_payment_id&whop_payment_id=in.(${inList})`,
        { headers: supaHeaders() }
      );
      if (checkRes.ok) {
        const rows = await checkRes.json();
        rows.forEach(r => { if (r.whop_payment_id) existingDeals.add(r.whop_payment_id); });
      }
    }

    // --- 3b. find which Whop payments are already in `retainer_payments` ---
    const existingRetainerPayments = new Set();
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const inList = chunk.map(id => `"${id}"`).join(',');
      try {
        const checkRes = await fetch(
          `${SUPABASE_URL}/rest/v1/retainer_payments?select=whop_payment_id&whop_payment_id=in.(${inList})`,
          { headers: supaHeaders() }
        );
        if (checkRes.ok) {
          const rows = await checkRes.json();
          rows.forEach(r => { if (r.whop_payment_id) existingRetainerPayments.add(r.whop_payment_id); });
        }
      } catch (e) {
        // Don't block deals sync if retainer table query fails
      }
    }

    // --- 4. build deal rows for payments not already logged + run retainer sync ---
    const seen = new Set();
    const newDealRows = [];
    const retainerStats = {
      newClientsCreated: 0,
      paymentsAllocated: 0,
      paymentsFlagged: 0,
      retainerErrors: [],
    };

    for (const p of htPayments) {
      if (!p.id || seen.has(p.id)) continue;
      seen.add(p.id);

      const gross = grossOf(p);
      const paidAt = p.paid_at || p.created_at || null;
      const dateOnly = paidAt ? String(paidAt).split('T')[0] : null;
      const customerName  = (p.billing_address && p.billing_address.name) || (p.user && p.user.name) || null;
      const customerEmail = (p.user && p.user.email) || null;

      // ── Deals row (existing behaviour) ──
      if (!existingDeals.has(p.id)) {
        newDealRows.push({
          name:    customerName,
          email:   customerEmail,
          date:    dateOnly,
          usd:     gross,
          contract: 0,
          source:  'ads',
          closer:  null,
          setter:  null,
          notes:   'Auto-synced from Whop',
          whop_payment_id: p.id,
        });
      }

      // ── Retainer sync (NEW) ──
      if (!existingRetainerPayments.has(p.id) && dateOnly && gross > 0) {
        try {
          await syncToRetainerSystem({
            whop_payment_id: p.id,
            amount: gross,
            paid_at: dateOnly,
            customer_name: (customerName || '').trim(),
            customer_email: (customerEmail || '').trim().toLowerCase(),
          }, retainerStats);
        } catch (err) {
          retainerStats.retainerErrors.push({ payment_id: p.id, error: err.message });
        }
      }
    }

    // --- 5. insert the new deals (if any) ---
    let dealsWritten = 0;
    if (newDealRows.length > 0) {
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/deals`, {
        method: 'POST',
        headers: supaHeaders({ 'Prefer': 'return=minimal' }),
        body: JSON.stringify(newDealRows),
      });

      if (!insertRes.ok) {
        const errText = await insertRes.text();
        return res.status(502).json({ ok: false, stage: 'supabase-deals', status: insertRes.status, error: errText });
      }
      dealsWritten = newDealRows.length;
    }

    const totalGross = newDealRows.reduce((s, r) => s + (r.usd || 0), 0);
    return res.status(200).json({
      ok: true,
      dealsWritten,
      totalGrossUsd: +totalGross.toFixed(2),
      ltSkipped,
      alreadyLogged: existingDeals.size,
      whopPaymentsSeen: payments.length,
      whopPagesFetched: pages,
      retainer: retainerStats,
    });

  } catch (e) {
    return res.status(500).json({ ok: false, stage: 'exception', error: e.message });
  }
}

// =========================================================
// RETAINER SYSTEM
// =========================================================

async function syncToRetainerSystem(payment, stats) {
  // ── Match client: email → name → create new ──
  let client = await findClientByEmail(payment.customer_email);
  if (!client) client = await findClientByName(payment.customer_name);

  let isNewClient = false;
  if (!client) {
    client = await createNewClient(payment);
    isNewClient = true;
    stats.newClientsCreated++;
  }

  // ── Determine allocation ──
  const allocation = await determineAllocation(client, payment, isNewClient);

  // ── Insert retainer_payments row ──
  await supaInsertOne('retainer_payments', {
    client_id:       client.id,
    whop_payment_id: payment.whop_payment_id,
    amount:          payment.amount,
    paid_at:         payment.paid_at,
    allocated_to:    allocation.bucket,
    status:          allocation.status,
    amount_expected: allocation.expected,
    notes:           allocation.notes,
  });
  stats.paymentsAllocated++;
  if (allocation.status !== 'paid') stats.paymentsFlagged++;
}

async function findClientByEmail(email) {
  if (!email) return null;
  const encoded = encodeURIComponent(email);
  const rows = await supaSelect(`retainer_clients?email=ilike.${encoded}&limit=2`);
  if (!rows || rows.length === 0) return null;
  if (rows.length > 1) return null;  // ambiguous → don't auto-match
  return rows[0];
}

async function findClientByName(name) {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const encoded = encodeURIComponent(trimmed);
  const rows = await supaSelect(`retainer_clients?name=ilike.${encoded}&limit=2`);
  if (!rows || rows.length === 0) return null;
  if (rows.length > 1) return null;  // ambiguous → don't auto-match
  return rows[0];
}

async function createNewClient(payment) {
  return await supaInsertOne('retainer_clients', {
    name:           payment.customer_name || 'Unknown',
    email:          payment.customer_email || null,
    deposit_date:   payment.paid_at,
    setup_complete: false,
    notes:          'Auto-created from Whop payment — awaiting retainer setup',
  }, /* returnRow */ true);
}

async function determineAllocation(client, payment, isNewClient) {
  // New client → first payment is always deposit
  if (isNewClient) {
    return {
      bucket: 'deposit',
      status: 'paid',
      expected: null,
      notes: 'First payment — auto-allocated as deposit',
    };
  }

  // Existing client: tally what's already paid per installment
  const prior = await supaSelect(
    `retainer_payments?select=allocated_to,amount&client_id=eq.${client.id}`
  );
  const totals = { deposit: 0, retainer_2: 0, final_retainer: 0 };
  for (const row of prior || []) {
    if (Object.prototype.hasOwnProperty.call(totals, row.allocated_to)) {
      totals[row.allocated_to] += Number(row.amount) || 0;
    }
  }

  // Setup not complete → can't auto-allocate yet
  if (!client.setup_complete) {
    return {
      bucket: 'unallocated',
      status: 'flagged',
      expected: null,
      notes: 'Payment arrived before retainer setup complete — needs manual allocation',
    };
  }

  // Sequence: retainer_2 → final_retainer
  const r2Expected = Number(client.retainer_2_amount || 0);
  const r2Paid     = totals.retainer_2;
  if (r2Paid < r2Expected - PARTIAL_TOLERANCE) {
    const wouldCover = r2Paid + payment.amount;
    if (wouldCover >= r2Expected - PARTIAL_TOLERANCE) {
      return { bucket: 'retainer_2', status: 'paid', expected: r2Expected, notes: null };
    }
    return {
      bucket: 'retainer_2',
      status: 'partial',
      expected: r2Expected,
      notes: `Partial: $${payment.amount.toFixed(2)} of $${r2Expected.toFixed(2)} expected`,
    };
  }

  const finalExpected = Number(client.final_retainer_amount || 0);
  const finalPaid     = totals.final_retainer;
  if (finalPaid < finalExpected - PARTIAL_TOLERANCE) {
    const wouldCover = finalPaid + payment.amount;
    if (wouldCover >= finalExpected - PARTIAL_TOLERANCE) {
      return { bucket: 'final_retainer', status: 'paid', expected: finalExpected, notes: null };
    }
    return {
      bucket: 'final_retainer',
      status: 'partial',
      expected: finalExpected,
      notes: `Partial: $${payment.amount.toFixed(2)} of $${finalExpected.toFixed(2)} expected`,
    };
  }

  // All installments covered → over-payment / extra
  return {
    bucket: 'unallocated',
    status: 'flagged',
    expected: null,
    notes: 'Extra payment beyond setup totals — needs manual review',
  };
}
