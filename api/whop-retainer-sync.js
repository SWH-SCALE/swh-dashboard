// =========================================================
// api/whop-sync.js
// =========================================================
// Pulls paid payments from Whop and syncs them to two destinations:
//   1. public.deals               (existing — Executive tab cash collected)
//   2. public.retainer_payments   (new — Retainers tab tracking)
//
// Retainer matching rules:
//   1. Lookup retainer_clients by email (case-insensitive)
//   2. Fallback: lookup by name (case-insensitive, trimmed)
//   3. No match → create new client (setup_complete=false), allocate as deposit
//
// Allocation rules for matched clients:
//   - Next unpaid installment in sequence: retainer_2 → final_retainer
//   - If no unpaid installments left → 'unallocated' (over-payment)
//   - Amount more than $50 below expected → status 'partial', flagged
//
// Idempotent via whop_payment_id UNIQUE constraint on both tables.
// =========================================================

import { createClient } from '@supabase/supabase-js';

const PARTIAL_TOLERANCE = 50;          // USD — within $50 = "paid in full"
const WHOP_PRODUCT_NAME = 'Scaling With High Ticket';
const WHOP_API_BASE     = 'https://api.whop.com/api/v5';

export default async function handler(req, res) {
  // Vercel cron or manual trigger
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const stats = {
    whopPaymentsSeen: 0,
    whopPagesFetched: 0,
    newDealsInserted: 0,
    newClientsCreated: 0,
    paymentsAllocated: 0,
    paymentsFlagged: 0,
    skippedAlreadySynced: 0,
    errors: [],
  };

  try {
    // ── 1. Pull paid payments from Whop (paginated) ──
    const payments = await fetchAllWhopPayments(stats);

    // ── 2. Process each payment ──
    for (const p of payments) {
      stats.whopPaymentsSeen++;

      // Skip if not from the Scaling With High Ticket product
      if (p.product_name && p.product_name !== WHOP_PRODUCT_NAME) continue;

      // Skip if status isn't paid (extra safety — Whop API should already filter)
      if (p.status && p.status.toLowerCase() !== 'paid') continue;

      try {
        await processPayment(supabase, p, stats);
      } catch (err) {
        stats.errors.push({ payment_id: p.id, error: err.message });
      }
    }

    return res.status(200).json({ ok: true, stats });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
      stats,
    });
  }
}

// ─── Whop API: paginated fetch ──────────────────────────
async function fetchAllWhopPayments(stats) {
  const all = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const url = `${WHOP_API_BASE}/company/payments?page=${page}&per=${perPage}&status=paid`;
    const r = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${process.env.WHOP_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    if (!r.ok) {
      throw new Error(`Whop API ${r.status}: ${await r.text()}`);
    }

    const json = await r.json();
    const items = json.data || json.payments || [];
    stats.whopPagesFetched++;

    if (items.length === 0) break;
    all.push(...items);

    // Stop if we got a partial page (last page)
    if (items.length < perPage) break;
    page++;

    // Safety: cap at 50 pages to avoid runaway
    if (page > 50) break;
  }

  return all;
}

// ─── Process one Whop payment ───────────────────────────
async function processPayment(supabase, p, stats) {
  // Normalise the payment fields (defensive about Whop API shape)
  const payment = {
    whop_payment_id: p.id,
    amount: parseFloat(p.amount_usd || p.total_amount_usd || p.amount || 0),
    paid_at: (p.paid_at || p.created_at || '').slice(0, 10),
    customer_name: (p.customer_name || p.user_name || '').trim(),
    customer_email: (p.email || p.customer_email || '').trim().toLowerCase(),
  };

  if (!payment.whop_payment_id || !payment.amount || !payment.paid_at) {
    throw new Error('Missing required payment fields');
  }

  // ── A. Sync to deals table (Executive tab) ──
  await syncToDealsTable(supabase, payment, stats);

  // ── B. Sync to retainer_payments table (Retainers tab) ──
  await syncToRetainerSystem(supabase, payment, stats);
}

// ─── Deals table: idempotent insert ─────────────────────
async function syncToDealsTable(supabase, payment, stats) {
  // Check if already synced
  const { data: existing } = await supabase
    .from('deals')
    .select('id')
    .eq('whop_payment_id', payment.whop_payment_id)
    .maybeSingle();

  if (existing) {
    stats.skippedAlreadySynced++;
    return;
  }

  const { error } = await supabase.from('deals').insert({
    name: payment.customer_name || 'Unknown',
    email: payment.customer_email || null,
    date: payment.paid_at,
    usd: payment.amount,
    source: 'ads',
    whop_payment_id: payment.whop_payment_id,
    notes: 'Auto-synced from Whop',
  });

  if (error) throw new Error(`deals insert: ${error.message}`);
  stats.newDealsInserted++;
}

// ─── Retainer system: match → allocate → insert ──────────
async function syncToRetainerSystem(supabase, payment, stats) {
  // Idempotency: skip if this Whop payment is already in retainer_payments
  const { data: alreadyAllocated } = await supabase
    .from('retainer_payments')
    .select('id')
    .eq('whop_payment_id', payment.whop_payment_id)
    .maybeSingle();
  if (alreadyAllocated) return;

  // ── Match client: email → name → create new ──
  let client = await findClientByEmail(supabase, payment.customer_email);
  if (!client) client = await findClientByName(supabase, payment.customer_name);

  let isNewClient = false;
  if (!client) {
    client = await createNewClient(supabase, payment);
    isNewClient = true;
    stats.newClientsCreated++;
  }

  // ── Allocate ──
  const allocation = await determineAllocation(supabase, client, payment, isNewClient);

  // ── Insert payment row ──
  const { error } = await supabase.from('retainer_payments').insert({
    client_id: client.id,
    whop_payment_id: payment.whop_payment_id,
    amount: payment.amount,
    paid_at: payment.paid_at,
    allocated_to: allocation.bucket,
    status: allocation.status,
    amount_expected: allocation.expected,
    notes: allocation.notes,
  });

  if (error) throw new Error(`retainer_payments insert: ${error.message}`);
  stats.paymentsAllocated++;
  if (allocation.status !== 'paid') stats.paymentsFlagged++;
}

// ─── Match: email lookup ────────────────────────────────
async function findClientByEmail(supabase, email) {
  if (!email) return null;
  const { data } = await supabase
    .from('retainer_clients')
    .select('*')
    .ilike('email', email)
    .maybeSingle();
  return data;
}

// ─── Match: name lookup ─────────────────────────────────
async function findClientByName(supabase, name) {
  if (!name) return null;
  // Case-insensitive exact-name match (after trim)
  const trimmed = name.trim();
  const { data } = await supabase
    .from('retainer_clients')
    .select('*')
    .ilike('name', trimmed)
    .limit(2);  // detect ambiguity

  if (!data || data.length === 0) return null;
  if (data.length > 1) {
    // Ambiguous — don't auto-match, treat as new client (safer)
    return null;
  }
  return data[0];
}

// ─── Create new client (treats payment as deposit per spec) ──
async function createNewClient(supabase, payment) {
  const { data, error } = await supabase
    .from('retainer_clients')
    .insert({
      name: payment.customer_name || 'Unknown',
      email: payment.customer_email || null,
      deposit_date: payment.paid_at,
      setup_complete: false,
      notes: 'Auto-created from Whop payment — awaiting retainer setup',
    })
    .select('*')
    .single();

  if (error) throw new Error(`retainer_clients insert: ${error.message}`);
  return data;
}

// ─── Determine which installment this payment covers ──────
async function determineAllocation(supabase, client, payment, isNewClient) {
  // New client → always treat first payment as deposit
  if (isNewClient) {
    return {
      bucket: 'deposit',
      status: 'paid',
      expected: null,
      notes: 'First payment — auto-allocated as deposit',
    };
  }

  // Existing client: figure out what's already been paid
  const { data: prior } = await supabase
    .from('retainer_payments')
    .select('allocated_to, amount')
    .eq('client_id', client.id);

  const totals = {
    deposit: 0,
    retainer_2: 0,
    final_retainer: 0,
  };
  for (const row of prior || []) {
    if (totals.hasOwnProperty(row.allocated_to)) {
      totals[row.allocated_to] += Number(row.amount);
    }
  }

  // If setup is still pending, this client only has a deposit — treat extras as unallocated
  // (the second payment shouldn't happen before setup, but be defensive)
  if (!client.setup_complete) {
    return {
      bucket: 'unallocated',
      status: 'flagged',
      expected: null,
      notes: 'Payment arrived before retainer setup complete — needs manual allocation',
    };
  }

  // Sequence: deposit → retainer_2 → final_retainer
  // Deposit handled above (only happens for new clients). For existing clients
  // who somehow paid less than total_deal_value on deposit and pay more later,
  // we still move on to retainer_2 (deposit is closed once recorded).

  // Try retainer_2
  const r2Expected = Number(client.retainer_2_amount || 0);
  const r2Paid = totals.retainer_2;
  if (r2Paid < r2Expected - PARTIAL_TOLERANCE) {
    // Retainer 2 is still owed
    const wouldCover = r2Paid + payment.amount;
    if (wouldCover >= r2Expected - PARTIAL_TOLERANCE) {
      return {
        bucket: 'retainer_2',
        status: 'paid',
        expected: r2Expected,
        notes: null,
      };
    } else {
      return {
        bucket: 'retainer_2',
        status: 'partial',
        expected: r2Expected,
        notes: `Partial: $${payment.amount.toFixed(2)} of $${r2Expected.toFixed(2)} expected`,
      };
    }
  }

  // Try final_retainer
  const finalExpected = Number(client.final_retainer_amount || 0);
  const finalPaid = totals.final_retainer;
  if (finalPaid < finalExpected - PARTIAL_TOLERANCE) {
    const wouldCover = finalPaid + payment.amount;
    if (wouldCover >= finalExpected - PARTIAL_TOLERANCE) {
      return {
        bucket: 'final_retainer',
        status: 'paid',
        expected: finalExpected,
        notes: null,
      };
    } else {
      return {
        bucket: 'final_retainer',
        status: 'partial',
        expected: finalExpected,
        notes: `Partial: $${payment.amount.toFixed(2)} of $${finalExpected.toFixed(2)} expected`,
      };
    }
  }

  // All installments paid → over-payment / extra
  return {
    bucket: 'unallocated',
    status: 'flagged',
    expected: null,
    notes: 'Extra payment beyond setup totals — needs manual review',
  };
}
