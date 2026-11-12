import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore, fakeSender } from './memory-store.mjs';
import { evaluateInstalment } from '../api/_lib/engine.js';
import { createCheckoutLink, ensureLink } from '../api/_lib/links.js';
import { runReminders } from '../api/_lib/runner.js';

process.env.BUSINESS_TIMEZONE = 'Asia/Dubai';
process.env.WHOP_API_KEY = 'test_key';
process.env.WHOP_INSTALMENT_PRODUCT_ID = 'prod_INST';

// Fake Whop API: records calls, returns checkout configurations
function fakeWhop({ status = 200, shapeFail = false, priceOverride = null } = {}) {
  const calls = []; let n = 0;
  const f = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, body, headers: init.headers });
    await new Promise(r => setImmediate(r));
    if (init.method === 'DELETE') return { ok: true, status: 200, json: async () => ({}) };
    if (shapeFail && body.plan) return { ok: false, status: 422, json: async () => ({ error: { message: 'unknown field plan' } }) };
    if (status !== 200) return { ok: false, status, json: async () => ({ error: { message: 'missing permission checkout_configuration:create' } }) };
    n++;
    const p = body.plan || body.variant;
    return { ok: true, status: 200, json: async () => ({
      id: `ch_${n}`, purchase_url: `/checkout/ch_${n}/`,
      [body.plan ? 'plan' : 'variant']: { id: `plan_${n}`, initial_price: priceOverride ?? p.initial_price, currency: p.currency, [body.plan ? 'plan_type' : 'billing_type']: 'one_time' },
    }) };
  };
  f.calls = calls; f.creates = () => calls.filter(c => c.method === 'POST'); f.deletes = () => calls.filter(c => c.method === 'DELETE');
  return f;
}

const client = { id: 'c1', name: 'John Smith', email: 'john@client.com' };
const inst = { id: 'i1', client_id: 'c1', installment_number: 2, amount_usd: 3000, due_date: '2026-11-20', paid: false };
const seed = () => ({ clients: [client], instalments: [structuredClone(inst)], settings: { c1: { auto_reminders: true } }, links: {} });

test('request: one-time, hidden, single-use, USD, exact amount, existing product, instalment metadata', async () => {
  const whop = fakeWhop();
  const r = await createCheckoutLink({ inst, client, amount: 3000, generation: 1, productId: 'prod_INST', fetchImpl: whop });
  const { body, headers } = whop.creates()[0];
  assert.equal(body.plan.plan_type, 'one_time');
  assert.equal(body.plan.visibility, 'hidden');
  assert.equal(body.plan.stock, 1);
  assert.equal(body.plan.currency, 'usd');
  assert.equal(body.plan.initial_price, 3000);
  assert.equal(body.plan.product_id, 'prod_INST');
  assert.equal(body.plan.renewal_price, undefined);
  assert.equal(body.plan.billing_period, undefined);
  assert.equal(body.product, undefined);                       // never creates a product
  assert.deepEqual(body.metadata, { instalment_id: 'i1', client_id: 'c1', source: 'swh-dashboard' });
  assert.match(headers['Idempotency-Key'], /^swh-inst-i1-300000-g1$/);
  assert.equal(r.url, 'https://whop.com/checkout/ch_1/');
});

test('falls back to the newer Whop API shape if the first is rejected', async () => {
  const whop = fakeWhop({ shapeFail: true });
  const r = await createCheckoutLink({ inst, client, amount: 3000, generation: 1, productId: 'prod_INST', fetchImpl: whop });
  assert.equal(whop.creates()[1].body.variant.billing_type, 'one_time');
  assert.equal(whop.creates()[1].body.variant.unlimited_stock, false);
  assert.equal(r.planId, 'plan_1');
});

test('link that comes back with the wrong price is deleted, never used', async () => {
  const whop = fakeWhop({ priceOverride: 30 });
  await assert.rejects(createCheckoutLink({ inst, client, amount: 3000, generation: 1, productId: 'prod_INST', fetchImpl: whop }), /doesn't match/);
  assert.equal(whop.deletes().length, 1);
});

test('missing Whop permissions: clear message', async () => {
  await assert.rejects(createCheckoutLink({ inst, client, amount: 3000, generation: 1, productId: 'p', fetchImpl: fakeWhop({ status: 403 }) }), /needs checkout and plan permissions/);
});

test('no duplicates: same amount reuses the link; partial payment replaces it and deletes the old one', async () => {
  const store = createMemoryStore(seed()); const whop = fakeWhop();
  const a = await ensureLink(store, { inst, client, amountDue: 3000, fetchImpl: whop });
  const b = await ensureLink(store, { inst, client, amountDue: 3000, fetchImpl: whop });
  assert.equal(a.created, true); assert.equal(b.created, false);
  assert.equal(whop.creates().length, 1);
  const c = await ensureLink(store, { inst, client, amountDue: 1800, fetchImpl: whop });
  assert.equal(c.created, true);
  assert.equal(whop.creates()[1].body.plan.initial_price, 1800);
  assert.equal(whop.deletes().length, 1);
  assert.match(whop.deletes()[0].url, /ch_1$/);
  assert.equal(store.db.links.i1.verified_amount, 1800);
});

test('two requests at the same moment create one link', async () => {
  const store = createMemoryStore(seed()); const whop = fakeWhop();
  const results = await Promise.allSettled([1, 2, 3].map(() => ensureLink(store, { inst, client, amountDue: 3000, fetchImpl: whop })));
  assert.equal(whop.creates().length, 1);
  assert.ok(results.some(r => r.status === 'fulfilled'));
});

test('a pasted (manual) link is never replaced automatically', async () => {
  const s = seed(); s.links.i1 = { instalment_id: 'i1', client_id: 'c1', url: 'https://whop.com/checkout/plan_M/', source: 'manual', verify_status: 'unverified' };
  const store = createMemoryStore(s); const whop = fakeWhop();
  const r = await ensureLink(store, { inst, client, amountDue: 3000, fetchImpl: whop });
  assert.equal(r.created, false); assert.equal(whop.creates().length, 0);
  const forced = await ensureLink(store, { inst, client, amountDue: 3000, replaceManual: true, fetchImpl: whop });
  assert.equal(forced.created, true);
});

test('engine: auto links fill gaps; manual mismatches still held; no email = never sent', () => {
  const ctx = { client, settings: { auto_reminders: true }, paidAmount: 0, sends: [] };
  assert.equal(evaluateInstalment(inst, { ...ctx, link: null }, '2026-11-20', { autoLinks: true }).link_action, 'generate');
  assert.equal(evaluateInstalment(inst, { ...ctx, link: null }, '2026-11-20', { autoLinks: false }).state, 'held');
  const gen = { url: 'https://whop.com/checkout/ch_1/', source: 'generated', verified_amount: 3000, verified_currency: 'usd' };
  assert.equal(evaluateInstalment(inst, { ...ctx, link: gen, paidAmount: 1000 }, '2026-11-20', { autoLinks: true }).link_action, 'regenerate');
  assert.equal(evaluateInstalment(inst, { ...ctx, link: { ...gen, retired_at: 'x' } }, '2026-11-20', { autoLinks: true }).link_action, 'generate');
  const manual = { url: 'https://whop.com/checkout/plan_M/', source: 'manual', verify_status: 'verified', verified_amount: 2500, verified_currency: 'usd' };
  assert.equal(evaluateInstalment(inst, { ...ctx, link: manual }, '2026-11-20', { autoLinks: true }).state, 'held');
  const noEmail = evaluateInstalment(inst, { ...ctx, client: { ...client, email: null }, link: null }, '2026-11-20', { autoLinks: true });
  assert.equal(noEmail.state, 'held'); assert.match(noEmail.reason, /Missing email/);
});

test('daily run (live): link created just in time and put in the email', async () => {
  const store = createMemoryStore(seed()); const send = fakeSender(); const whop = fakeWhop();
  const ensure = (st, args) => ensureLink(st, { ...args, fetchImpl: whop });
  await runReminders({ store, send, now: new Date('2026-11-20T06:00:00Z'), live: true, ensureLink: ensure, retireLink: async () => true });
  assert.equal(send.sent.length, 1);
  assert.match(send.sent[0].html, /https:\/\/whop\.com\/checkout\/ch_1\//);
  assert.equal(whop.creates().length, 1);
});

test('daily run (test mode): no Whop links are created', async () => {
  const store = createMemoryStore(seed()); const send = fakeSender(); const whop = fakeWhop();
  const s = await runReminders({ store, send, now: new Date('2026-11-20T06:00:00Z'), ensureLink: (st, a) => ensureLink(st, { ...a, fetchImpl: whop }) });
  assert.equal(whop.creates().length, 0); assert.equal(send.sent.length, 0);
  assert.equal(s.would_send[0].link, 'created automatically');
});

test('link creation fails: no email sent, retried on the next run', async () => {
  const store = createMemoryStore(seed()); const send = fakeSender();
  let fail = true;
  const ensure = async (st, a) => { if (fail) { fail = false; throw new Error('Whop down'); } return ensureLink(st, { ...a, fetchImpl: fakeWhop() }); };
  const r1 = await runReminders({ store, send, now: new Date('2026-11-20T06:00:00Z'), live: true, ensureLink: ensure, retireLink: async () => true });
  assert.equal(r1.failed, 1); assert.equal(send.sent.length, 0);
  await runReminders({ store, send, now: new Date('2026-11-20T08:00:00Z'), live: true, ensureLink: ensure, retireLink: async () => true });
  assert.equal(send.sent.length, 1);
});

test('instalment ticked paid by hand: its generated link is switched off by the next run', async () => {
  const s = seed();
  s.instalments[0].paid = true;
  s.links.i1 = { instalment_id: 'i1', client_id: 'c1', url: 'https://whop.com/checkout/ch_9/', source: 'generated', checkout_config_id: 'ch_9', verified_amount: 3000 };
  const store = createMemoryStore(s); const retired = [];
  await runReminders({ store, send: fakeSender(), now: new Date('2026-11-20T06:00:00Z'), retireLink: async (st, id) => { retired.push(id); return true; } });
  assert.deepEqual(retired, ['i1']);
});
