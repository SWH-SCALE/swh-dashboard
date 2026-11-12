// /api/reminders
//   GET  (Vercel cron, Authorization: Bearer CRON_SECRET) -> daily reminder run
//   POST (dashboard, header x-admin-passcode)              -> { action, ... }
//
// Live client emails are only sent when REMINDERS_LIVE=true in Vercel.
// Otherwise everything runs in test mode: previews and test emails only.

import { settings, missingConfig, STAGES, AMOUNT_TOLERANCE } from './_lib/config.js';
import { todayIn, isIsoDate } from './_lib/dates.js';
import { createStore } from './_lib/db.js';
import { buildPlan, simulateUpcoming, isValidEmail, isWhopUrl, round2 } from './_lib/engine.js';
import { buildReminderEmail } from './_lib/email.js';
import { sendEmail, authUrl, revoke } from './_lib/gmail.js';
import { runReminders } from './_lib/runner.js';
import { verifyLink, applyPayment } from './_lib/whop.js';
import { send, readJson, isCron, isAdmin } from './_lib/http.js';

const gmailSender = store => (gmailRow, msg) => sendEmail(store, gmailRow, msg);

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      if (!isCron(req)) return send(res, 401, { ok: false, error: 'Unauthorized' });
      const store = createStore();
      const summary = await runReminders({ store, send: gmailSender(store), trigger: 'cron' });
      return send(res, 200, { ok: true, summary });
    }
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });

    if (!(await isAdmin(req))) {
      const configured = !!process.env.DASHBOARD_ADMIN_PASSCODE;
      return send(res, 401, { ok: false, error: configured ? 'Wrong passcode' : 'DASHBOARD_ADMIN_PASSCODE is not set in Vercel' });
    }
    const body = await readJson(req);
    const action = ACTIONS[body.action];
    if (!action) return send(res, 400, { ok: false, error: `Unknown action "${body.action}"` });
    const store = createStore();
    const result = await action({ store, body, req });
    return send(res, 200, { ok: true, ...result });
  } catch (e) {
    console.error('reminders error', e);
    return send(res, e.status || 500, { ok: false, error: e.message });
  }
}

function fail(message, status = 400) { const e = new Error(message); e.status = status; return e; }

const ACTIONS = {
  async check() { return {}; },

  async state({ store }) {
    const cfg = settings();
    const today = todayIn(cfg.timezone);
    const data = await store.loadAll();
    const plan = buildPlan(data, today);
    const [reviews, log] = await Promise.all([store.openReviews(), store.recentLog(80)]);

    const lastByClient = {};
    for (const s of data.sends) {
      if (s.status !== 'sent') continue;
      const k = String(s.client_id);
      if (!lastByClient[k] || String(s.sent_at) > String(lastByClient[k].at)) {
        lastByClient[k] = { at: s.sent_at, stage: s.stage, to: s.to_email };
      }
    }
    const clients = {};
    for (const c of data.clients) {
      const k = String(c.id); const s = data.settings[k] || {};
      clients[k] = {
        auto_reminders: !!s.auto_reminders, paused: !!s.paused,
        reminder_email: s.reminder_email || null, client_email: c.email || null,
        last_sent: lastByClient[k] || null,
      };
    }
    const instalments = {};
    for (const it of plan.items) {
      const l = data.links[it.instalment_id];
      instalments[it.instalment_id] = {
        state: it.state, stage: it.stage, next_stage: it.next_stage, next_date: it.next_date,
        reason: it.reason, warnings: it.warnings, amount_paid: it.amount_paid, amount_due: it.amount_due,
        last_sent: it.last_sent,
        link: l ? { url: l.url, verify_status: l.verify_status, verified_amount: l.verified_amount, verified_currency: l.verified_currency, verify_note: l.verify_note } : null,
      };
    }
    const g = data.gmail || {};
    return {
      mode: cfg.live ? 'live' : 'test', timezone: cfg.timezone, today,
      missing_config: missingConfig(),
      gmail: { status: g.status || 'disconnected', email: g.email || null, connected_at: g.connected_at || null, last_used_at: g.last_used_at || null, last_error: g.last_error || null },
      test_email: cfg.testEmail || g.email || null,
      from_name: cfg.fromName,
      clients, instalments, reviews, log,
      stages: STAGES,
    };
  },

  async preview({ store }) {
    const cfg = settings();
    const today = todayIn(cfg.timezone);
    const data = await store.loadAll();
    const plan = buildPlan(data, today);
    const upcoming = simulateUpcoming(data, today, 14);
    const attention = plan.items
      .filter(i => (i.state === 'held') || (i.state === 'scheduled' && i.warnings?.length) || i.state === 'missed')
      .map(i => ({ client_name: i.client_name, instalment_number: i.instalment_number, instalment_id: i.instalment_id, client_id: i.client_id, due_date: i.due_date, state: i.state, reason: i.reason || (i.warnings || []).join('; ') }));
    return { mode: cfg.live ? 'live' : 'test', today, upcoming, attention };
  },

  async run({ store }) {
    const summary = await runReminders({ store, send: gmailSender(store), trigger: 'manual' });
    return { summary };
  },

  async 'test-send'({ store, body }) {
    const cfg = settings();
    const data = await store.loadAll();
    const gmail = data.gmail;
    if (!gmail || gmail.status !== 'connected') throw fail('Connect Gmail first');
    const to = cfg.testEmail || gmail.email;
    if (!isValidEmail(to)) throw fail('No test inbox configured');

    const stage = STAGES.some(s => s.key === body.stage) ? body.stage : 'due';
    let inst = body.instalment_id ? data.instalments.find(i => String(i.id) === String(body.instalment_id)) : null;
    const client = inst ? data.clients.find(c => String(c.id) === String(inst.client_id)) : null;
    const link = inst ? data.links[String(inst.id)] : null;
    const paid = inst ? (data.paidByInstalment[String(inst.id)] || 0) : 0;
    const amountTotal = inst ? round2(inst.amount_usd) : 3000;
    const email = buildReminderEmail({
      stage, test: true,
      clientName: client?.name || 'Alex Example',
      amountTotal, amountPaid: paid, amountDue: round2(amountTotal - paid),
      dueDate: (inst && isIsoDate(inst.due_date)) ? inst.due_date.slice(0, 10) : todayIn(cfg.timezone),
      whopUrl: link?.url || 'https://whop.com/checkout/plan_EXAMPLE/',
      signOff: cfg.signOff,
    });
    const r = await sendEmail(store, gmail, { to, ...email });
    await store.insertTestSend({
      instalment_id: inst ? String(inst.id) : 'sample', client_id: inst ? String(inst.client_id) : 'sample',
      due_date: (inst && isIsoDate(inst.due_date)) ? inst.due_date.slice(0, 10) : todayIn(cfg.timezone),
      stage, status: 'sent', to_email: to, amount_usd: round2(amountTotal - paid), whop_url: link?.url || null,
      subject: email.subject, gmail_message_id: r?.id || null, sent_at: new Date().toISOString(),
    });
    await store.log({ event: 'test_email_sent', client_id: inst ? String(inst.client_id) : null, instalment_id: inst ? String(inst.id) : null,
      message: `Test email (${stage}) sent to ${to}${client ? ` using ${client.name}'s instalment` : ''}. No client was emailed.` });
    return { sent_to: to, subject: email.subject };
  },

  async 'save-client'({ store, body }) {
    const cid = String(body.client_id || '');
    const client = cid && await store.getClient(cid);
    if (!client) throw fail('Client not found');
    const row = { client_id: cid };
    const changes = [];
    if (typeof body.auto_reminders === 'boolean') { row.auto_reminders = body.auto_reminders; changes.push(`auto reminders ${body.auto_reminders ? 'ON' : 'OFF'}`); }
    if (typeof body.paused === 'boolean') { row.paused = body.paused; changes.push(body.paused ? 'reminders paused' : 'reminders resumed'); }
    if (body.reminder_email !== undefined) {
      const e = String(body.reminder_email || '').trim().toLowerCase();
      if (e && !isValidEmail(e)) throw fail('That email address is not valid');
      row.reminder_email = e || null; changes.push(`reminder email set to ${e || '(client email)'}`);
    }
    if (row.auto_reminders === true) {
      const existing = await store.getSettings(cid);
      const effective = (row.reminder_email !== undefined ? row.reminder_email : existing?.reminder_email) || client.email || '';
      if (!isValidEmail(effective)) throw fail('Add an email for this client before switching reminders on');
    }
    const saved = await store.upsertSettings(row);
    await store.log({ event: 'settings_changed', client_id: cid, message: `${client.name}: ${changes.join(', ')}.` });
    return { settings: saved };
  },

  async 'save-link'({ store, body }) {
    const inst = await store.getInstalment(String(body.instalment_id || ''));
    if (!inst) throw fail('Instalment not found');
    const url = String(body.url || '').trim();
    if (!url) throw fail('Paste a Whop link');
    if (!isWhopUrl(url)) throw fail('Paste the full https://whop.com/... payment link');
    const v = await verifyLink(url);
    const saved = await store.upsertLink({
      instalment_id: String(inst.id), client_id: String(inst.client_id), url,
      plan_id: v.plan_id || null, verify_status: v.verify_status, verified_amount: v.verified_amount ?? null,
      verified_currency: v.verified_currency ?? null, verify_note: v.verify_note ?? null, verified_at: v.verified_at ?? null,
    });
    const owed = round2(Number(inst.amount_usd) - Number(inst.amount_paid_usd || 0));
    let note = v.verify_status === 'verified'
      ? (Math.abs(Number(v.verified_amount) - owed) > AMOUNT_TOLERANCE
          ? `Warning: link charges $${v.verified_amount} but $${owed} is due. Reminders for this instalment are held until fixed.`
          : `Verified: $${v.verified_amount} ${String(v.verified_currency).toUpperCase()}`)
      : (v.verify_note || 'Saved');
    await store.log({ event: 'link_saved', client_id: String(inst.client_id), instalment_id: String(inst.id), message: `Whop link saved for instalment #${inst.installment_number}. ${note}` });
    return { link: saved, note };
  },

  async 'remove-link'({ store, body }) {
    const inst = await store.getInstalment(String(body.instalment_id || ''));
    if (!inst) throw fail('Instalment not found');
    await store.deleteLink(String(inst.id));
    await store.log({ event: 'link_removed', client_id: String(inst.client_id), instalment_id: String(inst.id), message: `Whop link removed from instalment #${inst.installment_number}.` });
    return {};
  },

  async 'record-payment'({ store, body }) {
    const inst = await store.getInstalment(String(body.instalment_id || ''));
    if (!inst) throw fail('Instalment not found');
    const amount = round2(body.amount);
    if (!(amount > 0)) throw fail('Enter an amount above zero');
    const date = isIsoDate(body.paid_date) ? body.paid_date.slice(0, 10) : todayIn(settings().timezone);
    await store.insertPayment({
      instalment_id: String(inst.id), client_id: String(inst.client_id), source: 'manual',
      amount_usd: amount, currency: 'usd', paid_at: `${date}T12:00:00Z`, match_method: 'manual',
      notes: String(body.notes || '').slice(0, 500) || null,
    });
    const r = await store.applyLedger(String(inst.id), date);
    const client = await store.getClient(String(inst.client_id));
    await store.log({ event: r.covered ? 'payment_confirmed' : 'payment_partial', client_id: String(inst.client_id), instalment_id: String(inst.id),
      message: `Manual payment recorded: ${client?.name || 'client'} paid $${amount} on ${date} for instalment #${inst.installment_number}. ${r.covered ? 'Marked paid, reminders stopped.' : `$${round2(r.total - r.sum)} still due.`}` });
    return { covered: r.covered, paid: r.sum, total: r.total };
  },

  async history({ store, body }) {
    const cid = String(body.client_id || '');
    const [sends, payments, log] = await Promise.all([store.sendsForClient(cid), store.paymentsForClient(cid), store.recentLog(100, cid)]);
    return { sends, payments, log };
  },

  async 'resolve-review'({ store, body }) {
    const review = await store.getReview(String(body.whop_payment_id || ''));
    if (!review || review.status !== 'open') throw fail('This payment has already been handled');
    const data = await store.loadAll();
    const inst = data.instalments.find(i => String(i.id) === String(body.instalment_id));
    if (!inst) throw fail('Pick an instalment');
    const pay = {
      id: review.whop_payment_id, amount: round2(review.amount_usd), currency: review.currency || 'usd',
      paidAt: review.paid_at || new Date().toISOString(), email: review.payer_email,
    };
    const r = await applyPayment(store, data, pay, inst, 'manual_review');
    await store.resolveReview(review.whop_payment_id, 'applied', String(inst.id));
    return r;
  },

  async 'dismiss-review'({ store, body }) {
    const r = await store.resolveReview(String(body.whop_payment_id || ''), 'dismissed', null);
    if (r) await store.log({ event: 'payment_review_dismissed', message: `Whop payment ${r.whop_payment_id} ($${r.amount_usd} from ${r.payer_email || 'unknown'}) marked as not an instalment.` });
    return {};
  },

  async 'gmail-connect-url'({ req }) {
    return { url: authUrl(req) };
  },

  async 'gmail-disconnect'({ store }) {
    const g = await store.getGmail();
    await revoke(g);
    await store.saveGmail({ status: 'disconnected', refresh_token_enc: null, last_error: null });
    await store.log({ event: 'gmail_disconnected', message: `Gmail ${g.email || ''} disconnected. No emails can be sent until it is reconnected.` });
    return {};
  },
};

// Exported for tests
export { ACTIONS };
