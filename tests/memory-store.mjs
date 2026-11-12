// In-memory stand-in for api/_lib/db.js createStore(), with the same
// guarantees the real database enforces (unique live sends, unique Whop
// payment IDs, append-only ledger, job lock). Used by the tests only.

import crypto from 'node:crypto';
import { round2 } from '../api/_lib/engine.js';
import { AMOUNT_TOLERANCE } from '../api/_lib/config.js';

const tick = () => new Promise(r => setImmediate(r)); // simulate network latency / interleaving

export function createMemoryStore(seed = {}) {
  const db = {
    clients: seed.clients || [],
    instalments: seed.instalments || [],
    settings: seed.settings || {},
    links: seed.links || {},
    payments: [],
    sends: [],
    reviews: [],
    webhooks: {},
    log: [],
    gmail: seed.gmail || { id: 1, status: 'connected', email: 'billing@swh.test', refresh_token_enc: 'x' },
    lock: null,
  };
  const now = () => new Date().toISOString();

  const store = {
    db,
    async loadAll() {
      await tick();
      const paidByInstalment = {};
      for (const p of db.payments) paidByInstalment[p.instalment_id] = round2((paidByInstalment[p.instalment_id] || 0) + p.amount_usd);
      return structuredClone({
        clients: db.clients, instalments: db.instalments, settings: db.settings, links: db.links,
        paidByInstalment, sends: db.sends.filter(s => s.mode === 'live'), gmail: db.gmail,
      });
    },
    async getInstalment(id) { await tick(); return structuredClone(db.instalments.find(i => String(i.id) === String(id)) || null); },
    async getClient(id) { await tick(); return structuredClone(db.clients.find(c => String(c.id) === String(id)) || null); },
    async ledgerSum(id) { await tick(); return round2(db.payments.filter(p => p.instalment_id === String(id)).reduce((s, p) => s + p.amount_usd, 0)); },

    async claimLock(name, holder, seconds) {
      await tick();
      if (db.lock && db.lock.until > Date.now()) return false;
      db.lock = { holder, until: Date.now() + seconds * 1000 };
      return true;
    },
    async releaseLock(name, holder) { if (db.lock?.holder === holder) db.lock = null; },

    async claimSend(row) {
      await tick();
      if (row.mode === 'live' && db.sends.some(s => s.mode === 'live' && s.instalment_id === row.instalment_id && s.due_date === row.due_date && s.stage === row.stage)) return null;
      const r = { id: crypto.randomUUID(), attempts: 1, created_at: now(), updated_at: now(), ...row };
      db.sends.push(r);
      return structuredClone(r);
    },
    async reclaimFailed(id, attempts) {
      await tick();
      const s = db.sends.find(x => x.id === id && x.status === 'failed');
      if (!s) return null;
      Object.assign(s, { status: 'sending', attempts, updated_at: now() });
      return structuredClone(s);
    },
    async updateSend(id, patch) { await tick(); Object.assign(db.sends.find(x => x.id === id), patch, { updated_at: now() }); },
    async markStaleSending(minutes) {
      const cutoff = Date.now() - minutes * 60000;
      const stale = db.sends.filter(s => s.status === 'sending' && new Date(s.updated_at).getTime() < cutoff);
      stale.forEach(s => { s.status = 'uncertain'; });
      return structuredClone(stale);
    },
    async insertTestSend(row) { db.sends.push({ id: crypto.randomUUID(), ...row, mode: 'test' }); },
    async sendsForClient(cid) { return db.sends.filter(s => s.client_id === cid); },

    async getSettings(cid) { return db.settings[cid] || null; },
    async upsertSettings(row) { db.settings[row.client_id] = { auto_reminders: false, paused: false, ...(db.settings[row.client_id] || {}), ...row }; return db.settings[row.client_id]; },
    async upsertLink(row) { db.links[row.instalment_id] = { ...(db.links[row.instalment_id] || {}), ...row }; return db.links[row.instalment_id]; },
    async deleteLink(id) { delete db.links[id]; },

    async insertPayment(row) {
      await tick();
      if (!(row.amount_usd > 0)) throw new Error('amount must be > 0');
      if (row.whop_payment_id && db.payments.some(p => p.whop_payment_id === row.whop_payment_id)) return null;
      const r = Object.freeze({ id: crypto.randomUUID(), recorded_at: now(), ...row, amount_usd: round2(row.amount_usd) });
      db.payments.push(r);
      return r;
    },
    async paymentsByWhopIds(ids) { await tick(); return db.payments.filter(p => ids.includes(p.whop_payment_id)); },
    async paymentsForClient(cid) { return db.payments.filter(p => p.client_id === cid); },
    async applyLedger(instalmentId, paidDate) {
      await tick();
      const inst = db.instalments.find(i => String(i.id) === String(instalmentId));
      if (!inst) return { found: false };
      const sum = await store.ledgerSum(instalmentId);
      const total = round2(inst.amount_usd);
      const covered = sum >= total - AMOUNT_TOLERANCE;
      const newlyPaid = covered && !inst.paid;
      inst.amount_paid_usd = sum;
      if (newlyPaid) { inst.paid = true; inst.paid_date = paidDate; }
      return { found: true, sum, total, covered, newlyPaid };
    },

    async addReview(row) { if (!db.reviews.some(r => r.whop_payment_id === row.whop_payment_id)) db.reviews.push({ status: 'open', ...row }); },
    async openReviews() { return db.reviews.filter(r => r.status === 'open'); },
    async getReview(id) { return db.reviews.find(r => r.whop_payment_id === id) || null; },
    async resolveReview(id, status, iid) {
      const r = db.reviews.find(x => x.whop_payment_id === id && x.status === 'open');
      if (!r) return null; Object.assign(r, { status, resolved_instalment_id: iid }); return r;
    },

    async claimWebhook(id, type, payload) {
      await tick();
      const ev = db.webhooks[id];
      if (!ev) { db.webhooks[id] = { status: 'processing', attempts: 1, type, received: Date.now() }; return { claimed: true }; }
      if (ev.status === 'error') { ev.status = 'processing'; ev.attempts++; return { claimed: true, retry: true }; }
      return { claimed: false, status: ev.status };
    },
    async finishWebhook(id, status, error) { db.webhooks[id].status = status; db.webhooks[id].error = error; },

    async log(entry) { db.log.push({ level: 'info', created_at: now(), ...entry }); },
    async recentLog() { return db.log.slice().reverse(); },
    async getGmail() { return db.gmail; },
    async saveGmail(patch) { Object.assign(db.gmail, patch); },
  };
  return store;
}

// Fake Gmail sender that records what it "sent"
export function fakeSender({ failWith = null } = {}) {
  const sent = [];
  const fn = async (gmailRow, msg) => {
    await tick();
    if (typeof failWith === 'function') { const e = failWith(msg, sent.length); if (e) throw e; }
    else if (failWith) throw failWith;
    const id = 'msg_' + (sent.length + 1);
    sent.push({ id, ...msg });
    return { id };
  };
  fn.sent = sent;
  return fn;
}
