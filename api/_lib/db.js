// Supabase access for the reminder system. Server-side only, using the
// service role key from Vercel env (never sent to the browser).

import { SUPABASE_URL, env, AMOUNT_TOLERANCE } from './config.js';
import { round2 } from './engine.js';

export class ConflictError extends Error {}

function key() {
  const k = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!k) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set in Vercel');
  return k;
}

export async function rest(path, { method = 'GET', body, prefer, headers = {} } = {}) {
  const k = key();
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: k,
      Authorization: `Bearer ${k}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (r.status === 409 || (data && data.code === '23505')) throw new ConflictError(data?.message || 'conflict');
  if (!r.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]} ${r.status}: ${typeof data === 'string' ? data : data?.message || text}`);
  return data;
}

const enc = encodeURIComponent;
const inList = ids => `(${ids.map(i => `"${String(i).replace(/"/g, '')}"`).join(',')})`;

export function createStore() {
  return {
    // ── Reads ────────────────────────────────────────────────
    async loadAll() {
      const [clients, instalments, settingsRows, linkRows, payRows, sends, gmail] = await Promise.all([
        rest('retainer_clients?select=*'),
        rest('retainer_installments?select=*&order=client_id.asc,installment_number.asc'),
        rest('reminder_client_settings?select=*'),
        rest('instalment_whop_links?select=*'),
        rest('instalment_payments?select=instalment_id,amount_usd'),
        rest('reminder_sends?select=*&mode=eq.live&order=created_at.asc'),
        this.getGmail(),
      ]);
      const settings = {}; for (const s of settingsRows) settings[String(s.client_id)] = s;
      const links = {}; for (const l of linkRows) links[String(l.instalment_id)] = l;
      const paidByInstalment = {};
      for (const p of payRows) {
        const k = String(p.instalment_id);
        paidByInstalment[k] = round2((paidByInstalment[k] || 0) + Number(p.amount_usd));
      }
      return { clients, instalments, settings, links, paidByInstalment, sends, gmail };
    },

    async getInstalment(id) {
      const rows = await rest(`retainer_installments?select=*&id=eq.${enc(id)}`);
      return rows[0] || null;
    },
    async getClient(id) {
      const rows = await rest(`retainer_clients?select=*&id=eq.${enc(id)}`);
      return rows[0] || null;
    },
    async ledgerSum(instalmentId) {
      const rows = await rest(`instalment_payments?select=amount_usd&instalment_id=eq.${enc(instalmentId)}`);
      return round2(rows.reduce((s, r) => s + Number(r.amount_usd), 0));
    },

    // ── Locks ────────────────────────────────────────────────
    async claimLock(name, holder, seconds) {
      return (await rest('rpc/claim_job_lock', { method: 'POST', body: { p_name: name, p_holder: holder, p_seconds: seconds } })) === true;
    },
    async releaseLock(name, holder) {
      await rest('rpc/release_job_lock', { method: 'POST', body: { p_name: name, p_holder: holder } });
    },

    // ── Reminder sends ───────────────────────────────────────
    async claimSend(row) {
      try {
        const rows = await rest('reminder_sends', { method: 'POST', body: row, prefer: 'return=representation' });
        return rows[0];
      } catch (e) {
        if (e instanceof ConflictError) return null; // another run already has it
        throw e;
      }
    },
    async reclaimFailed(id, attempts) {
      const rows = await rest(`reminder_sends?id=eq.${enc(id)}&status=eq.failed`, {
        method: 'PATCH', prefer: 'return=representation',
        body: { status: 'sending', attempts, updated_at: new Date().toISOString() },
      });
      return rows[0] || null;
    },
    async updateSend(id, patch) {
      await rest(`reminder_sends?id=eq.${enc(id)}`, {
        method: 'PATCH', body: { ...patch, updated_at: new Date().toISOString() },
      });
    },
    async markStaleSending(minutes = 15) {
      const cutoff = new Date(Date.now() - minutes * 60000).toISOString();
      return rest(`reminder_sends?status=eq.sending&updated_at=lt.${enc(cutoff)}`, {
        method: 'PATCH', prefer: 'return=representation',
        body: { status: 'uncertain', last_error: 'Run stopped mid-send. Check the Gmail Sent folder before resending.', updated_at: new Date().toISOString() },
      });
    },
    async insertTestSend(row) {
      await rest('reminder_sends', { method: 'POST', body: { ...row, mode: 'test' } });
    },
    async sendsForClient(clientId) {
      return rest(`reminder_sends?select=*&client_id=eq.${enc(clientId)}&order=created_at.desc&limit=200`);
    },

    // ── Settings & links ─────────────────────────────────────
    async getSettings(clientId) {
      const rows = await rest(`reminder_client_settings?select=*&client_id=eq.${enc(clientId)}`);
      return rows[0] || null;
    },
    async upsertSettings(row) {
      const rows = await rest('reminder_client_settings?on_conflict=client_id', {
        method: 'POST', prefer: 'resolution=merge-duplicates,return=representation',
        body: { ...row, updated_at: new Date().toISOString() },
      });
      return rows[0];
    },
    async upsertLink(row) {
      const rows = await rest('instalment_whop_links?on_conflict=instalment_id', {
        method: 'POST', prefer: 'resolution=merge-duplicates,return=representation',
        body: { ...row, updated_at: new Date().toISOString() },
      });
      return rows[0];
    },
    async deleteLink(instalmentId) {
      await rest(`instalment_whop_links?instalment_id=eq.${enc(instalmentId)}`, { method: 'DELETE' });
    },
    async linksByPlan(planId) {
      return rest(`instalment_whop_links?select=*&plan_id=eq.${enc(planId)}`);
    },

    // ── Payments ledger (append-only) ────────────────────────
    async insertPayment(row) {
      try {
        const rows = await rest('instalment_payments', { method: 'POST', body: row, prefer: 'return=representation' });
        return rows[0];
      } catch (e) {
        if (e instanceof ConflictError) return null; // this Whop payment is already recorded
        throw e;
      }
    },
    async paymentsByWhopIds(ids) {
      if (!ids.length) return [];
      return rest(`instalment_payments?select=whop_payment_id,instalment_id&whop_payment_id=in.${enc(inList(ids))}`);
    },
    async paymentsForClient(clientId) {
      return rest(`instalment_payments?select=*&client_id=eq.${enc(clientId)}&order=paid_at.desc`);
    },
    // Recompute an instalment's paid total from the ledger and update the
    // Retainers tab. Idempotent: safe to call any number of times.
    async applyLedger(instalmentId, paidDate) {
      const inst = await this.getInstalment(instalmentId);
      if (!inst) return { found: false };
      const sum = await this.ledgerSum(instalmentId);
      const total = round2(inst.amount_usd);
      const covered = sum >= total - AMOUNT_TOLERANCE;
      const patch = { amount_paid_usd: sum, updated_at: new Date().toISOString() };
      if (covered && !inst.paid) { patch.paid = true; patch.paid_date = paidDate; }
      await rest(`retainer_installments?id=eq.${enc(instalmentId)}`, { method: 'PATCH', body: patch });
      return { found: true, sum, total, covered, newlyPaid: covered && !inst.paid };
    },

    // ── Payment reviews ──────────────────────────────────────
    async addReview(row) {
      try { await rest('payment_reviews', { method: 'POST', body: row }); }
      catch (e) { if (!(e instanceof ConflictError)) throw e; }
    },
    async openReviews() {
      return rest('payment_reviews?select=*&status=eq.open&order=created_at.desc');
    },
    async getReview(id) {
      const rows = await rest(`payment_reviews?select=*&whop_payment_id=eq.${enc(id)}`);
      return rows[0] || null;
    },
    async resolveReview(id, status, instalmentId) {
      const rows = await rest(`payment_reviews?whop_payment_id=eq.${enc(id)}&status=eq.open`, {
        method: 'PATCH', prefer: 'return=representation',
        body: { status, resolved_at: new Date().toISOString(), resolved_instalment_id: instalmentId || null },
      });
      return rows[0] || null;
    },

    // ── Webhook events ───────────────────────────────────────
    async claimWebhook(id, type, payload) {
      try {
        await rest('webhook_events', { method: 'POST', body: { webhook_id: id, event_type: type, payload } });
        return { claimed: true };
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
      }
      const [ev] = await rest(`webhook_events?select=*&webhook_id=eq.${enc(id)}`);
      if (!ev) return { claimed: false, status: 'unknown' };
      const stale = ev.status === 'processing' && Date.now() - new Date(ev.received_at).getTime() > 5 * 60000;
      if (ev.status === 'error' || stale) {
        const rows = await rest(`webhook_events?webhook_id=eq.${enc(id)}&status=eq.${ev.status}`, {
          method: 'PATCH', prefer: 'return=representation',
          body: { status: 'processing', attempts: (ev.attempts || 1) + 1, received_at: new Date().toISOString(), error: null },
        });
        if (rows[0]) return { claimed: true, retry: true };
      }
      return { claimed: false, status: ev.status };
    },
    async finishWebhook(id, status, error = null) {
      await rest(`webhook_events?webhook_id=eq.${enc(id)}`, {
        method: 'PATCH', body: { status, error, processed_at: new Date().toISOString() },
      });
    },

    // ── Activity log ─────────────────────────────────────────
    async log(entry) {
      try {
        await rest('automation_log', { method: 'POST', body: { level: 'info', ...entry } });
      } catch (e) { console.error('automation_log write failed', e.message, entry); }
    },
    async recentLog(limit = 100, clientId = null) {
      const f = clientId ? `&client_id=eq.${enc(clientId)}` : '';
      return rest(`automation_log?select=*&order=created_at.desc&limit=${limit}${f}`);
    },

    // ── Gmail connection ─────────────────────────────────────
    async getGmail() {
      const rows = await rest('gmail_connection?select=*&id=eq.1');
      return rows[0] || { id: 1, status: 'disconnected' };
    },
    async saveGmail(patch) {
      await rest('gmail_connection?on_conflict=id', {
        method: 'POST', prefer: 'resolution=merge-duplicates',
        body: { id: 1, ...patch, updated_at: new Date().toISOString() },
      });
    },
  };
}
