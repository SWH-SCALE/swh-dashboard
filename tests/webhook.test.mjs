import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createMemoryStore, fakeSender } from './memory-store.mjs';
import { handleWhopWebhook } from '../api/whop-webhook.js';
import { runReminders } from '../api/_lib/runner.js';

process.env.BUSINESS_TIMEZONE = 'Asia/Dubai';
const SECRET = 'ws_test_secret_value_1234567890abcdef';
const NOW = 1795000000;

function sign(body, id = 'msg_' + crypto.randomUUID(), ts = NOW, secret = SECRET) {
  const sig = crypto.createHmac('sha256', Buffer.from(secret)).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${sig}` };
}
const payment = (o = {}) => ({
  id: 'pay_1', status: 'paid', substatus: 'succeeded', total: 3000, usd_total: 3000, currency: 'usd',
  paid_at: '2026-11-21T10:00:00Z', user: { email: 'john@client.com', name: 'John Smith' },
  plan: { id: 'plan_A' }, product: { id: 'prod_HT' }, ...o,
});
const event = (data, type = 'payment.succeeded') => JSON.stringify({ id: 'evt', type, data });

function seed() {
  return {
    clients: [{ id: 'c1', name: 'John Smith', email: 'john@client.com' }, { id: 'c2', name: 'Sara Lee', email: 'sara@client.com' }],
    instalments: [
      { id: 'i1', client_id: 'c1', installment_number: 2, amount_usd: 3000, due_date: '2026-11-23', paid: false },
      { id: 'i2', client_id: 'c1', installment_number: 3, amount_usd: 3000, due_date: '2026-12-23', paid: false },
      { id: 'i5', client_id: 'c2', installment_number: 2, amount_usd: 5000, due_date: '2026-11-25', paid: false },
    ],
    settings: { c1: { auto_reminders: true }, c2: { auto_reminders: true } },
    links: {
      i1: { instalment_id: 'i1', url: 'https://whop.com/checkout/plan_A/', plan_id: 'plan_A', verify_status: 'verified', verified_amount: 3000, verified_currency: 'usd' },
      i5: { instalment_id: 'i5', url: 'https://whop.com/checkout/plan_E/', plan_id: 'plan_E', verify_status: 'unverified' },
    },
  };
}
const call = (store, body, headers) => handleWhopWebhook({ store, rawBody: body, headers, secret: SECRET, nowSec: NOW });

test('successful webhook: matched by link, recorded, marked paid, reminders stop', async () => {
  const store = createMemoryStore(seed());
  const body = event(payment());
  const out = await call(store, body, sign(body));
  assert.equal(out.status, 200); assert.equal(out.body.outcome, 'applied');
  const i1 = store.db.instalments.find(i => i.id === 'i1');
  assert.equal(i1.paid, true); assert.equal(i1.paid_date, '2026-11-21'); assert.equal(i1.amount_paid_usd, 3000);
  assert.equal(store.db.payments.length, 1);
  assert.ok(store.db.log.some(l => l.event === 'payment_confirmed'));
  // reminders for i1 no longer go out
  const send = fakeSender();
  await runReminders({ store, send, now: new Date('2026-11-23T06:00:00Z'), live: true });
  assert.ok(!send.sent.some(m => m.to === 'john@client.com' && /3,000 is due today/.test(m.subject)));
});

test('duplicate delivery (same webhook id): acknowledged, not recorded twice', async () => {
  const store = createMemoryStore(seed());
  const body = event(payment()); const h = sign(body, 'msg_same');
  await call(store, body, h);
  const again = await call(store, body, h);
  assert.equal(again.status, 200); assert.equal(again.body.duplicate, true);
  assert.equal(store.db.payments.length, 1);
});

test('same payment sent again under a new webhook id: still recorded once', async () => {
  const store = createMemoryStore(seed());
  const body = event(payment());
  await call(store, body, sign(body, 'msg_a'));
  const out = await call(store, body, sign(body, 'msg_b'));
  assert.equal(out.body.outcome, 'duplicate');
  assert.equal(store.db.payments.length, 1);
});

test('parallel duplicate deliveries: recorded once', async () => {
  const store = createMemoryStore(seed());
  const body = event(payment()); const h = sign(body, 'msg_par');
  await Promise.all([call(store, body, h), call(store, body, h), call(store, body, sign(body, 'msg_par2'))]);
  assert.equal(store.db.payments.length, 1);
});

test('bad signature, wrong secret, old timestamp, missing headers: rejected, nothing recorded', async () => {
  const store = createMemoryStore(seed());
  const body = event(payment());
  const tampered = sign(body); const forged = event(payment({ total: 1, usd_total: 1 }));
  assert.equal((await call(store, forged, tampered)).status, 401);
  assert.equal((await call(store, body, sign(body, 'm1', NOW, 'ws_wrong'))).status, 401);
  assert.equal((await call(store, body, sign(body, 'm2', NOW - 3600))).status, 401);
  assert.equal((await call(store, body, {})).status, 401);
  assert.equal(store.db.payments.length, 0);
  assert.equal(store.db.log.filter(l => l.event === 'webhook_rejected').length, 4);
});

test('failed/pending payments and other events never mark anything paid', async () => {
  const store = createMemoryStore(seed());
  for (const [type, data] of [['payment.failed', payment({ status: 'open', substatus: 'failed' })], ['payment.pending', payment()], ['membership.activated', {}]]) {
    const body = event(data, type);
    const out = await call(store, body, sign(body));
    assert.equal(out.status, 200);
  }
  const body = event(payment({ id: 'pay_x', status: 'open', substatus: 'pending' }));
  await call(store, body, sign(body));
  assert.equal(store.db.payments.length, 0);
  assert.equal(store.db.instalments.find(i => i.id === 'i1').paid, false);
});

test('processing failure returns 500 so Whop retries; retry then succeeds once', async () => {
  const store = createMemoryStore(seed());
  const body = event(payment()); const h = sign(body, 'msg_retry');
  const orig = store.applyLedger; let fail = true;
  store.applyLedger = async (...a) => { if (fail) { fail = false; throw new Error('db down'); } return orig(...a); };
  assert.equal((await call(store, body, h)).status, 500);
  const ok = await call(store, body, h);
  assert.equal(ok.status, 200);
  assert.equal(store.db.payments.length, 1);
  assert.equal(store.db.instalments.find(i => i.id === 'i1').paid, true);
});

test('partial payment on a plan link: recorded, instalment stays unpaid with balance', async () => {
  const store = createMemoryStore(seed());
  const body = event(payment({ id: 'pay_p', total: 1000, usd_total: 1000 }));
  const out = await call(store, body, sign(body));
  assert.equal(out.body.outcome, 'partial');
  const i1 = store.db.instalments.find(i => i.id === 'i1');
  assert.equal(i1.paid, false); assert.equal(i1.amount_paid_usd, 1000);
});

test('no link match: email + exact amount picks the earliest unpaid instalment', async () => {
  const store = createMemoryStore(seed());
  const body = event(payment({ id: 'pay_e', plan: { id: 'plan_UNKNOWN' } }));
  const out = await call(store, body, sign(body));
  assert.equal(out.body.outcome, 'applied'); assert.equal(out.body.instalment_id, 'i1');
});

test('uncertain matches go to review, never guessed', async () => {
  const store = createMemoryStore(seed());
  const cases = [
    payment({ id: 'pay_r1', plan: { id: 'plan_UNKNOWN' }, total: 1234, usd_total: 1234 }),           // amount fits nothing
    payment({ id: 'pay_r2', plan: { id: 'plan_UNKNOWN' }, user: { email: 'stranger@x.com' } }),      // unknown payer
  ];
  for (const p of cases) { const b = event(p); await call(store, b, sign(b)); }
  assert.equal(store.db.payments.length, 0);
  assert.equal(store.db.reviews.length, 2);
});

test('low-ticket purchases by a retainer client are ignored', async () => {
  const store = createMemoryStore(seed());
  const body = event(payment({ id: 'pay_lt', total: 27, usd_total: 27, product: { id: 'prod_Q0nZad1rnebtx' }, plan: { id: 'plan_LT' } }));
  const out = await call(store, body, sign(body));
  assert.equal(out.body.outcome, 'ignored');
  assert.equal(store.db.payments.length, 0);
});

test('ledger is append-only (records cannot be edited)', async () => {
  const store = createMemoryStore(seed());
  const body = event(payment()); await call(store, body, sign(body));
  assert.throws(() => { store.db.payments[0].amount_usd = 1; });
});
