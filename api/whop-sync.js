// /api/whop-sync.js
// Pulls ALL payments from the Whop API and syncs them to TWO Supabase tables:
//
//   1. `deals`              — Executive tab cash-collected (all payments, with deal_type tag)
//   2. `retainer_payments`  — Retainers tab tracking (HT only)
//
// CLOSER AUTO-ATTRIBUTION (new):
//   For every new HT deal, this sync looks up the customer's most recent
//   `showed` call in calls_with_status by email match. If found, it copies
//   `closer` onto the new deals row. Falls back to most recent call of ANY
//   status if no `showed` call exists. NULL if no calendly call matches.
//   This means: customer books with Frankie's calendar → pays → deal row
//   gets closer='Frankie' automatically. No manual tagging required.
//
// Rules for `deals`:
//   - Pull every paid Whop payment for the company.
//   - LOW-TICKET payments (LT product ID or LT upsell amounts) are INCLUDED
//     with deal_type='lt' so cash-collected totals are complete.
//   - HIGH-TICKET payments go through the retainer matcher and get tagged:
//       - deposit          → deal_type='new_ht'
//       - retainer_2/final → deal_type='retainer'
//       - unallocated      → deal_type='back_end'
//   - source='ads' for everything; manual override to 'organic' allowed in UI.
//   - Idempotent via whop_payment_id UNIQUE constraint.
//
// Rules for retainer system (HT payments only):
//   - Match client by email (case-insensitive) → fallback to name match.
//   - No match → create new client (setup_complete=false), allocate as deposit.
//   - Existing client + setup complete → allocate to next unpaid installment
//     in sequence (retainer_2 → final_retainer). Amount > $50 below expected
//     → status 'partial' and flagged for review.
//   - Existing client + setup pending → 'unallocated' (defensive).
//
// Failure isolation: retainer-sync errors NEVER block deals-sync. Closer
// lookup errors NEVER block deals-sync. Worst case: deal gets closer=null
// and can be manually tagged via the UI dropdown.
//
// Runs daily via Vercel cron and on a manual GET to /api/whop-sync.

const WHOP_KEY     = process.env.WHOP_API_KEY;
const SUPABASE_URL = 'https://qstlyvauppjkdiwpgtql.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const WHOP_COMPANY_ID = 'biz_6YYccxU9EzDgfU';

// Low-ticket product(s) — these get tagged deal_type='lt' but still flow into deals.
const LT_PRODUCT_IDS = ['prod_Q0nZad1rnebtx'];

// Low-ticket UPSELL amounts (no dedicated product id, identified by exact $).
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

// Map a retainer allocation bucket to a deals.deal_type value.
function allocationToDealType(bucket) {
  switch (bucket) {
    case 'deposit':        return 'new_ht';
    case 'retainer_2':     return 'retainer';
    case 'final_retainer': return 'retainer';
    case 'unallocated':    return 'back_end';
    default:               return 'new_ht'; // fail-safe
  }
}

// ── CLOSER AUTO-ATTRIBUTION ────────────────────────────
// Look up customer's call in calls_with_status by email and return closer.
// Prefers a `showed` call (the one they actually closed on). Falls back to
// most recent call of any status. Returns null on no match or any error.
async function lookupCloserForCustomer(email) {
  if (!email) return null;
  const cleanEmail = String(email).trim().toLowerCase();
  if (!cleanEmail) return null;

  try {
    // Try showed calls first
    const showedRows = await supaSelect(
      `calls_with_status?select=closer,scheduled_at`
      + `&invitee_email=ilike.${encodeURIComponent(cleanEmail)}`
      + `&effective_status=eq.showed`
      + `&closer=not.is.null`
      + `&order=scheduled_at.desc&limit=1`
    );
    if (showedRows && showedRows.length > 0 && showedRows[0].closer) {
      return showedRows[0].closer;
    }

    // Fallback: most recent call regardless of status
    const anyRows = await supaSelect(
      `calls_with_status?select=closer,scheduled_at`
      + `&invitee_email=ilike.${encodeURIComponent(cleanEmail)}`
      + `&closer=not.is.null`
      + `&order=scheduled_at.desc&limit=1`
    );
    if (anyRows && anyRows.length > 0 && anyRows[0].closer) {
      return anyRows[0].closer;
    }
  } catch (e) {
    // Swallow — closer attribution is best-effort
    return null;
  }
  return null;
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

    // --- 2. keep paid/succeeded ---
    const paid = payments.filter(p =>
      p && (p.status === 'paid' || p.substatus === 'succeeded')
    );
    const isLowTicket = (p) =>
      LT_PRODUCT_IDS.includes(productIdOf(p)) || isLtUpsellAmount(grossOf(p));

    // --- 3. find which Whop payments are already in `deals` and `retainer_payments` ---
    const ids = paid.map(p => p.id).filter(Boolean);
    const existingDeals = new Set();
    const existingRetainerPayments = new Set();

    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const inList = chunk.map(id => `"${id}"`).join(',');

      // deals
      const dealsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/deals?select=whop_payment_id&whop_payment_id=in.(${inList})`,
        { headers: supaHeaders() }
      );
      if (dealsRes.ok) {
        (await dealsRes.json()).forEach(r => { if (r.whop_payment_id) existingDeals.add(r.whop_payment_id); });
      }

      // retainer_payments
      try {
        const retRes = await fetch(
          `${SUPABASE_URL}/rest/v1/retainer_payments?select=whop_payment_id&whop_payment_id=in.(${inList})`,
          { headers: supaHeaders() }
        );
        if (retRes.ok) {
          (await retRes.json()).forEach(r => { if (r.whop_payment_id) existingRetainerPayments.add(r.whop_payment_id); });
        }
      } catch (e) { /* don't block deals if retainer table errors */ }
    }

    // --- 4. process each payment ---
    const seen = new Set();
    const newDealRows = [];
    const stats = {
      newDealsHT: 0,
      newDealsLT: 0,
      newClientsCreated: 0,
      paymentsAllocated: 0,
      paymentsFlagged: 0,
      closersAttributed: 0,
      closersUnmatched: 0,
      retainerErrors: [],
    };

    for (const p of paid) {
      if (!p.id || seen.has(p.id)) continue;
      seen.add(p.id);

      const gross = grossOf(p);
      const paidAt = p.paid_at || p.created_at || null;
      const dateOnly = paidAt ? String(paidAt).split('T')[0] : null;
      const customerName  = (p.billing_address && p.billing_address.name) || (p.user && p.user.name) || null;
      const customerEmail = (p.user && p.user.email) || null;
      const lt = isLowTicket(p);

      let dealType;

      if (lt) {
        // ── LOW-TICKET payment ──
        // Goes into deals as deal_type='lt', does NOT touch retainer system.
        dealType = 'lt';
      } else {
        // ── HIGH-TICKET payment ──
        // Run through retainer matcher to determine deal_type.
        dealType = 'new_ht'; // safe default
        if (!existingRetainerPayments.has(p.id) && dateOnly && gross > 0) {
          try {
            const allocation = await syncToRetainerSystem({
              whop_payment_id: p.id,
              amount: gross,
              paid_at: dateOnly,
              customer_name: (customerName || '').trim(),
              customer_email: (customerEmail || '').trim().toLowerCase(),
            }, stats);
            dealType = allocationToDealType(allocation.bucket);
          } catch (err) {
            stats.retainerErrors.push({ payment_id: p.id, error: err.message });
            // dealType stays 'new_ht' (fail-safe — manually correctable in UI)
          }
        } else if (existingRetainerPayments.has(p.id)) {
          // Retainer record exists already — look up its allocated_to to backfill deal_type
          // for the case where deals row also already exists but lacks deal_type.
          try {
            const rows = await supaSelect(
              `retainer_payments?select=allocated_to&whop_payment_id=eq.${encodeURIComponent(p.id)}&limit=1`
            );
            if (rows && rows[0]) dealType = allocationToDealType(rows[0].allocated_to);
          } catch (e) { /* fail-safe stays 'new_ht' */ }
        }
      }

      // ── Insert into deals if not already there ──
      if (!existingDeals.has(p.id)) {
        // CLOSER AUTO-ATTRIBUTION: look up which closer this customer booked with.
        // Only for HT deals — LT payments don't go through closers.
        let attributedCloser = null;
        if (!lt) {
          attributedCloser = await lookupCloserForCustomer(customerEmail);
          if (attributedCloser) stats.closersAttributed++;
          else stats.closersUnmatched++;
        }

        newDealRows.push({
          name:    customerName,
          email:   customerEmail,
          date:    dateOnly,
          usd:     gross,
          contract: 0,
          source:  'ads',
          closer:  attributedCloser,
          setter:  null,
          notes:   lt ? 'Auto-synced from Whop (LT)' : 'Auto-synced from Whop',
          whop_payment_id: p.id,
          deal_type: dealType,
        });
        if (lt) stats.newDealsLT++; else stats.newDealsHT++;
      }
    }

    // --- 5. batch insert new deals ---
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
      alreadyLogged: existingDeals.size,
      whopPaymentsSeen: payments.length,
      whopPagesFetched: pages,
      breakdown: {
        newDealsHT: stats.newDealsHT,
        newDealsLT: stats.newDealsLT,
      },
      closerAttribution: {
        attributed: stats.closersAttributed,
        unmatched:  stats.closersUnmatched,
      },
      retainer: {
        newClientsCreated: stats.newClientsCreated,
        paymentsAllocated: stats.paymentsAllocated,
        paymentsFlagged: stats.paymentsFlagged,
        retainerErrors: stats.retainerErrors,
      },
    });

  } catch (e) {
    return res.status(500).json({ ok: false, stage: 'exception', error: e.message });
  }
}

// =========================================================
// RETAINER SYSTEM (HT only)
// =========================================================
// Returns { bucket, status, expected, notes } so the caller can use bucket
// to determine deal_type for the deals row.

async function syncToRetainerSystem(payment, stats) {
  let client = await findClientByEmail(payment.customer_email);
  if (!client) client = await findClientByName(payment.customer_name);

  let isNewClient = false;
  if (!client) {
    client = await createNewClient(payment);
    isNewClient = true;
    stats.newClientsCreated++;
  }

  const allocation = await determineAllocation(client, payment, isNewClient);

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

  return allocation;
}

async function findClientByEmail(email) {
  if (!email) return null;
  const encoded = encodeURIComponent(email);
  const rows = await supaSelect(`retainer_clients?email=ilike.${encoded}&limit=2`);
  if (!rows || rows.length === 0) return null;
  if (rows.length > 1) return null;
  return rows[0];
}

async function findClientByName(name) {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const encoded = encodeURIComponent(trimmed);
  const rows = await supaSelect(`retainer_clients?name=ilike.${encoded}&limit=2`);
  if (!rows || rows.length === 0) return null;
  if (rows.length > 1) return null;
  return rows[0];
}

async function createNewClient(payment) {
  return await supaInsertOne('retainer_clients', {
    name:           payment.customer_name || 'Unknown',
    email:          payment.customer_email || null,
    deposit_date:   payment.paid_at,
    setup_complete: false,
    notes:          'Auto-created from Whop payment — awaiting retainer setup',
  }, true);
}

async function determineAllocation(client, payment, isNewClient) {
  if (isNewClient) {
    return {
      bucket: 'deposit',
      status: 'paid',
      expected: null,
      notes: 'First payment — auto-allocated as deposit',
    };
  }

  const prior = await supaSelect(
    `retainer_payments?select=allocated_to,amount&client_id=eq.${client.id}`
  );
  const totals = { deposit: 0, retainer_2: 0, final_retainer: 0 };
  for (const row of prior || []) {
    if (Object.prototype.hasOwnProperty.call(totals, row.allocated_to)) {
      totals[row.allocated_to] += Number(row.amount) || 0;
    }
  }

  if (!client.setup_complete) {
    return {
      bucket: 'unallocated',
      status: 'flagged',
      expected: null,
      notes: 'Payment arrived before retainer setup complete — needs manual allocation',
    };
  }

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

  return {
    bucket: 'unallocated',
    status: 'flagged',
    expected: null,
    notes: 'Extra payment beyond setup totals — needs manual review',
  };
}
