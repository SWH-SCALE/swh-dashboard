import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore, fakeSender } from './memory-store.mjs';
import { runReminders } from '../api/_lib/runner.js';
import { GmailError } from '../api/_lib/gmail.js';

process.env.BUSINESS_TIMEZONE = 'Asia/Dubai';
delete process.env.REMINDERS_LIVE;

// 06:00 UTC = 10:00 in Dubai
const at = d => new Date(`${d}T06:00:00Z`);

function seed() {
  return {
    clients: [
      { id: 'c1', name: 'John Smith', email: 'john@client.com' },
      { id: 'c2', name: 'Sara Lee', email: 'sara@client.com' },
      { id: 'c3', name: 'Off Client', email: 'off@client.com' },
    ],
    instalments: [
      { id: 'i1', client_id: 'c1', installment_number: 2, amount_usd: 3000, due_date: '2026-11-23', paid: false }, // upcoming (pre3 on 11-20)
      { id: 'i2', client_id: 'c2', installment_number: 3, amount_usd: 5000, due_date: '2026-11-18', paid: false }, // overdue +2 on 11-20
      { id: 'i3', client_id: 'c2', installment_number: 2, amount_usd: 5000, due_date: '2026-11-20', paid: true },  // already paid
      { id: 'i4', client_id: 'c3', installment_number: 1, amount_usd: 2000, due_date: '2026-11-20', paid: false }, // reminders off
    ],
    settings: { c1: { auto_reminders: true }, c2: { auto_reminders: true }, c3: { auto_reminders: false } },
    links: {
      i1: { instalment_id: 'i1', url: 'https://whop.com/checkout/plan_A/', plan_id: 'plan_A', verify_status: 'verified', verified_amount: 3000, verified_currency: 'usd' },
      i2: { instalment_id: 'i2', url: 'https://whop.com/checkout/plan_B/', plan_id: 'plan_B', verify_status: 'unverified' },
      i4: { instalment_id: 'i4', url: 'https://whop.com/checkout/plan_D/', plan_id: 'plan_D', verify_status: 'unverified' },
    },
  };
}

test('TEST MODE: nothing is emailed, preview logged', async () => {
  const store = createMemoryStore(seed()); const send = fakeSender();
  const s = await runReminders({ store, send, now: at('2026-11-20') });
  assert.equal(s.mode, 'test');
  assert.equal(send.sent.length, 0);
  assert.equal(store.db.sends.length, 0);
  assert.deepEqual(s.would_send.map(w => [w.to, w.stage]).sort(), [['john@client.com', 'pre3'], ['sara@client.com', 'over2']]);
  assert.ok(store.db.log.some(l => l.event === 'dry_run'));
});

test('LIVE: upcoming + overdue sent; paid and switched-off skipped', async () => {
  const store = createMemoryStore(seed()); const send = fakeSender();
  const s = await runReminders({ store, send, now: at('2026-11-20'), live: true });
  assert.equal(s.sent, 2);
  assert.deepEqual(send.sent.map(m => m.to).sort(), ['john@client.com', 'sara@client.com']);
  const john = send.sent.find(m => m.to === 'john@client.com');
  assert.match(john.subject, /\$3,000 is due on/);
  assert.match(john.html, /https:\/\/whop\.com\/checkout\/plan_A\//);
  assert.ok(!send.sent.some(m => m.to === 'off@client.com'));
  assert.equal(store.db.sends.filter(x => x.status === 'sent').length, 2);
});

test('DUPLICATE RUNS (same day, one after another): each reminder sent once', async () => {
  const store = createMemoryStore(seed()); const send = fakeSender();
  await runReminders({ store, send, now: at('2026-11-20'), live: true });
  const second = await runReminders({ store, send, now: at('2026-11-20'), live: true });
  assert.equal(second.sent, 0);
  assert.equal(send.sent.length, 2);
});

test('DUPLICATE RUNS (overlapping): lock stops the second, still sent once', async () => {
  const store = createMemoryStore(seed()); const send = fakeSender();
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => runReminders({ store, send, now: at('2026-11-20'), live: true })));
  assert.equal(send.sent.length, 2);
  assert.equal([a, b, c].filter(x => x.locked).length, 2);
});

test('DUPLICATE RUNS (lock somehow bypassed): database claim still prevents double send', async () => {
  const store = createMemoryStore(seed()); const send = fakeSender();
  store.claimLock = async () => true; // simulate a broken lock
  await Promise.all([1, 2, 3, 4].map(() => runReminders({ store, send, now: at('2026-11-20'), live: true })));
  assert.equal(send.sent.length, 2);
});

test('full schedule over 10 days: exactly 5 emails per unpaid instalment', async () => {
  const store = createMemoryStore(seed()); const send = fakeSender();
  for (let d = 15; d <= 30; d++) {
    await runReminders({ store, send, now: at(`2026-11-${d}`), live: true });
    await runReminders({ store, send, now: at(`2026-11-${d}`), live: true }); // cron double-fire
  }
  const forJohn = send.sent.filter(m => m.to === 'john@client.com').map(m => m.subject);
  assert.equal(forJohn.length, 5);
  assert.match(forJohn[4], /^Final reminder/);
});

test('PAYMENT stops reminders immediately', async () => {
  const store = createMemoryStore(seed()); const send = fakeSender();
  await runReminders({ store, send, now: at('2026-11-20'), live: true });
  store.db.instalments.find(i => i.id === 'i1').paid = true;
  await runReminders({ store, send, now: at('2026-11-23'), live: true });
  assert.equal(send.sent.filter(m => m.to === 'john@client.com').length, 1);
});

test('paid between planning and sending: email cancelled', async () => {
  const store = createMemoryStore(seed()); const send = fakeSender();
  const orig = store.getInstalment;
  store.getInstalment = async id => { const r = await orig(id); if (id === 'i1') r.paid = true; return r; };
  await runReminders({ store, send, now: at('2026-11-20'), live: true });
  assert.ok(!send.sent.some(m => m.to === 'john@client.com'));
  assert.ok(store.db.sends.some(s => s.instalment_id === 'i1' && s.status === 'cancelled'));
});

test('PARTIAL payment: email shows remaining balance and thanks for amount paid', async () => {
  const s = seed();
  s.links.i1.verified_amount = 1000;
  const store = createMemoryStore(s); const send = fakeSender();
  await store.insertPayment({ instalment_id: 'i1', client_id: 'c1', source: 'manual', amount_usd: 2000, paid_at: '2026-11-10T00:00:00Z' });
  await runReminders({ store, send, now: at('2026-11-20'), live: true });
  const m = send.sent.find(x => x.to === 'john@client.com');
  assert.match(m.subject, /\$1,000/);
  assert.match(m.text, /\$2,000 already paid/);
});

test('failed send retried next run; Gmail auth failure stops the run', async () => {
  const store = createMemoryStore(seed());
  const flaky = fakeSender({ failWith: (msg, n) => n === 0 && msg.to === 'john@client.com' && !flaky.failedOnce ? (flaky.failedOnce = true, new GmailError('Backend Error', { kind: 'transient' })) : null });
  const r1 = await runReminders({ store, send: flaky, now: at('2026-11-20'), live: true });
  assert.equal(r1.failed, 1);
  const r2 = await runReminders({ store, send: flaky, now: at('2026-11-20'), live: true });
  assert.equal(r2.sent, 1);
  assert.ok(flaky.sent.some(m => m.to === 'john@client.com'));

  const store2 = createMemoryStore(seed());
  const dead = fakeSender({ failWith: new GmailError('revoked', { kind: 'auth' }) });
  const r3 = await runReminders({ store: store2, send: dead, now: at('2026-11-20'), live: true });
  assert.equal(r3.failed, 1); // stopped after the first
  assert.ok(r3.errors.includes('gmail_auth'));
});

test('uncertain send (timeout) is not resent automatically', async () => {
  const store = createMemoryStore(seed());
  const send = fakeSender({ failWith: msg => msg.to === 'john@client.com' ? new GmailError('timeout', { kind: 'uncertain' }) : null });
  await runReminders({ store, send, now: at('2026-11-20'), live: true });
  const ok = fakeSender();
  await runReminders({ store, send: ok, now: at('2026-11-20'), live: true });
  assert.equal(ok.sent.length, 0);
  assert.ok(store.db.sends.some(s => s.instalment_id === 'i1' && s.status === 'uncertain'));
});

test('Gmail not connected: live run sends nothing and logs an error', async () => {
  const store = createMemoryStore({ ...seed(), gmail: { id: 1, status: 'disconnected' } }); const send = fakeSender();
  const s = await runReminders({ store, send, now: at('2026-11-20'), live: true });
  assert.equal(send.sent.length, 0);
  assert.ok(s.errors.includes('gmail_not_connected'));
});
