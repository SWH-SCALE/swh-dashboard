// Reminder engine: pure functions, no I/O. Decides, for every instalment,
// whether a reminder is due today, scheduled, held (and why), or finished.
// Unit-tested in tests/engine.test.mjs.

import { STAGES, CATCH_UP_DAYS, MAX_SEND_ATTEMPTS, AMOUNT_TOLERANCE } from './config.js';
import { daysBetween, addDays, isIsoDate } from './dates.js';

const DONE_STATUSES = new Set(['sent', 'sending', 'uncertain']);

export function stageIndex(key) {
  return STAGES.findIndex(s => s.key === key);
}

export function isValidEmail(e) {
  return typeof e === 'string' && /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]{2,}$/.test(e.trim());
}

export function isWhopUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'whop.com' || u.hostname.endsWith('.whop.com'));
  } catch { return false; }
}

export function extractPlanId(url) {
  const m = String(url || '').match(/plan_[A-Za-z0-9]+/);
  return m ? m[0] : null;
}

export function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function firstName(fullName) {
  const clean = String(fullName || '').replace(/\(.*?\)/g, ' ').trim();
  const first = clean.split(/\s+/)[0] || '';
  if (!first || /@/.test(first)) return 'there';
  return first.charAt(0).toUpperCase() + first.slice(1);
}

// Problems that would stop an email going out for this instalment.
export function sendProblems({ toEmail, link, amountDue }) {
  const problems = [];
  if (!isValidEmail(toEmail)) problems.push('No valid email address for this client');
  if (!link || !link.url) {
    problems.push('No Whop payment link saved for this instalment');
  } else if (!isWhopUrl(link.url)) {
    problems.push('Payment link is not a secure whop.com link');
  } else if (link.verify_status === 'mismatch') {
    problems.push(link.verify_note || 'Whop link does not match this instalment');
  } else if (link.verify_status === 'verified') {
    if (link.verified_currency && link.verified_currency.toLowerCase() !== 'usd') {
      problems.push(`Whop link is in ${link.verified_currency.toUpperCase()}, instalment is USD`);
    } else if (link.verified_amount != null &&
               Math.abs(Number(link.verified_amount) - amountDue) > AMOUNT_TOLERANCE) {
      problems.push(`Whop link charges $${round2(link.verified_amount)} but $${round2(amountDue)} is due`);
    }
  }
  return problems;
}

/**
 * Evaluate one instalment for a given business date.
 * ctx: { client, settings, link, paidAmount, sends }  (sends = LIVE sends for this instalment)
 */
export function evaluateInstalment(inst, ctx, today, opts = {}) {
  const catchUp = opts.catchUpDays ?? CATCH_UP_DAYS;
  const client = ctx.client || {};
  const s = ctx.settings || {};
  const total = round2(inst.amount_usd);
  const ledgerPaid = round2(ctx.paidAmount || 0);
  const amountDue = round2(Math.max(0, total - ledgerPaid));
  const toEmail = (s.reminder_email || client.email || '').trim();
  const dueDate = isIsoDate(inst.due_date) ? inst.due_date.slice(0, 10) : null;

  const base = {
    instalment_id: String(inst.id),
    client_id: String(inst.client_id),
    client_name: client.name || '',
    instalment_number: inst.installment_number ?? null,
    to_email: toEmail,
    amount_total: total,
    amount_paid: ledgerPaid,
    amount_due: amountDue,
    due_date: dueDate,
    days_from_due: dueDate ? daysBetween(dueDate, today) : null,
    whop_url: ctx.link?.url || null,
    stage: null, next_stage: null, next_date: null, reason: null, retry_of: null, warnings: [],
  };

  const sends = (ctx.sends || []).filter(x => x.mode === 'live' && dueDate && String(x.due_date).slice(0, 10) === dueDate);
  const lastSent = sends
    .filter(x => x.status === 'sent')
    .sort((a, b) => String(b.sent_at || b.created_at).localeCompare(String(a.sent_at || a.created_at)))[0];
  base.last_sent = lastSent ? { stage: lastSent.stage, at: lastSent.sent_at || lastSent.created_at } : null;

  // 1. Paid (ticked in the dashboard, or fully covered by recorded payments)
  if (inst.paid === true || amountDue <= AMOUNT_TOLERANCE) return { ...base, state: 'paid', reason: 'Paid' };
  // 2. Client-level switches
  if (client.is_closed) return { ...base, state: 'closed', reason: 'Client is in Closed retainers' };
  if (client.is_paused) return { ...base, state: 'client_paused', reason: 'Client is paused in the dashboard' };
  if (!s.auto_reminders) return { ...base, state: 'off', reason: 'Auto reminders are off for this client' };
  if (s.paused) return { ...base, state: 'paused', reason: 'Reminders paused for this client' };
  if (!dueDate) return { ...base, state: 'held', reason: 'Instalment has no due date' };

  // 3. Where are we in the schedule?
  const diff = daysBetween(dueDate, today);
  let lastDoneIdx = -1;
  const failedByStage = {};
  for (const x of sends) {
    const i = stageIndex(x.stage);
    if (DONE_STATUSES.has(x.status) || (x.status === 'failed' && (x.attempts || 1) >= MAX_SEND_ATTEMPTS)) {
      lastDoneIdx = Math.max(lastDoneIdx, i);
    } else if (x.status === 'failed') {
      failedByStage[x.stage] = x;
    }
  }
  let ci = -1;
  STAGES.forEach((st, i) => { if (st.offset <= diff) ci = i; });

  const problems = sendProblems({ toEmail, link: ctx.link, amountDue });
  const scheduled = (idx, extra = {}) => {
    const next = STAGES[idx];
    return {
      ...base, state: 'scheduled', next_stage: next.key,
      next_date: addDays(dueDate, next.offset), warnings: problems, ...extra,
    };
  };

  if (ci === -1) return scheduled(0);

  if (ci <= lastDoneIdx) {
    const nextIdx = Math.max(ci, lastDoneIdx) + 1;
    if (nextIdx < STAGES.length) return scheduled(nextIdx);
    return { ...base, state: 'complete', reason: 'All 5 reminders sent. Follow up personally.' };
  }

  const current = STAGES[ci];
  if (diff - current.offset > catchUp) {
    if (ci + 1 < STAGES.length) return scheduled(ci + 1, { reason: `Missed "${current.label}" reminder` });
    return { ...base, state: 'missed', reason: 'Overdue beyond the reminder schedule. Not emailed automatically.' };
  }

  if (problems.length) return { ...base, state: 'held', stage: current.key, reason: problems.join('; ') };
  return { ...base, state: 'send', stage: current.key, retry_of: failedByStage[current.key] || null };
}

/** Index the raw tables into lookups used by evaluateInstalment. */
export function indexData(data) {
  const clients = new Map((data.clients || []).map(c => [String(c.id), c]));
  const sendsByInst = new Map();
  for (const x of data.sends || []) {
    const k = String(x.instalment_id);
    if (!sendsByInst.has(k)) sendsByInst.set(k, []);
    sendsByInst.get(k).push(x);
  }
  return { clients, sendsByInst };
}

export function buildPlan(data, today, opts = {}) {
  const { clients, sendsByInst } = indexData(data);
  const items = [];
  for (const inst of data.instalments || []) {
    const id = String(inst.id);
    const cid = String(inst.client_id);
    items.push(evaluateInstalment(inst, {
      client: clients.get(cid),
      settings: (data.settings || {})[cid],
      link: (data.links || {})[id],
      paidAmount: (data.paidByInstalment || {})[id] || 0,
      sends: sendsByInst.get(id) || [],
    }, today, opts));
  }
  return { today, items, toSend: items.filter(i => i.state === 'send') };
}

/** What the next N days look like, assuming each day's run sends what it should. */
export function simulateUpcoming(data, today, days = 14, opts = {}) {
  const simSends = [...(data.sends || [])];
  const timeline = [];
  for (let d = 0; d <= days; d++) {
    const date = addDays(today, d);
    const plan = buildPlan({ ...data, sends: simSends }, date, opts);
    for (const it of plan.items) {
      if (it.state !== 'send' && !(it.state === 'held' && it.stage)) continue;
      timeline.push({
        date, client_id: it.client_id, client_name: it.client_name, to_email: it.to_email,
        instalment_id: it.instalment_id, instalment_number: it.instalment_number,
        stage: it.stage, amount_due: it.amount_due, due_date: it.due_date,
        will_send: it.state === 'send', reason: it.reason,
      });
      simSends.push({
        instalment_id: it.instalment_id, due_date: it.due_date, stage: it.stage,
        mode: 'live', status: 'sent', sent_at: date,
      });
    }
  }
  return timeline;
}
