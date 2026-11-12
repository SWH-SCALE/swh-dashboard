import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateInstalment, buildPlan, simulateUpcoming, firstName, extractPlanId } from '../api/_lib/engine.js';

const client = { id: 'c1', name: 'John Smith', email: 'john@client.com' };
const on = { auto_reminders: true, paused: false };
const link = { url: 'https://whop.com/checkout/plan_ABC123/', plan_id: 'plan_ABC123', verify_status: 'verified', verified_amount: 3000, verified_currency: 'usd' };
const inst = (o = {}) => ({ id: 'i1', client_id: 'c1', installment_number: 2, amount_usd: 3000, due_date: '2026-11-20', paid: false, ...o });
const ev = (today, o = {}, ctx = {}) => evaluateInstalment(inst(o), { client, settings: on, link, paidAmount: 0, sends: [], ...ctx }, today);
const sent = (stage, due = '2026-11-20', status = 'sent', extra = {}) => ({ instalment_id: 'i1', due_date: due, stage, mode: 'live', status, ...extra });

test('upcoming: 3 days before due sends the pre3 reminder', () => {
  const r = ev('2026-11-17');
  assert.equal(r.state, 'send'); assert.equal(r.stage, 'pre3'); assert.equal(r.amount_due, 3000);
});

test('upcoming: more than 3 days out is scheduled, not sent', () => {
  const r = ev('2026-11-10');
  assert.equal(r.state, 'scheduled'); assert.equal(r.next_stage, 'pre3'); assert.equal(r.next_date, '2026-11-17');
});

test('each stage fires on its day: due, +2, +5, +7', () => {
  assert.equal(ev('2026-11-20', {}, { sends: [sent('pre3')] }).stage, 'due');
  assert.equal(ev('2026-11-22', {}, { sends: [sent('pre3'), sent('due')] }).stage, 'over2');
  assert.equal(ev('2026-11-25', {}, { sends: [sent('pre3'), sent('due'), sent('over2')] }).stage, 'over5');
  assert.equal(ev('2026-11-27', {}, { sends: [sent('pre3'), sent('due'), sent('over2'), sent('over5')] }).stage, 'over7');
});

test('between stages: next stage is scheduled', () => {
  const r = ev('2026-11-21', {}, { sends: [sent('pre3'), sent('due')] });
  assert.equal(r.state, 'scheduled'); assert.equal(r.next_stage, 'over2'); assert.equal(r.next_date, '2026-11-22');
});

test('after all five, nothing more is sent', () => {
  const all = ['pre3', 'due', 'over2', 'over5', 'over7'].map(s => sent(s));
  assert.equal(ev('2026-12-15', {}, { sends: all }).state, 'complete');
});

test('already paid: ticked paid in the dashboard', () => {
  assert.equal(ev('2026-11-20', { paid: true }).state, 'paid');
});

test('already paid: covered by recorded payments', () => {
  assert.equal(ev('2026-11-20', {}, { paidAmount: 3000 }).state, 'paid');
});

test('partial payment: reminder asks only for the remaining balance', () => {
  const r = ev('2026-11-20', {}, { paidAmount: 1000, link: { ...link, verified_amount: 2000 } });
  assert.equal(r.state, 'send'); assert.equal(r.amount_due, 2000); assert.equal(r.amount_paid, 1000);
});

test('partial payment: link for the full amount is held (would overcharge)', () => {
  const r = ev('2026-11-20', {}, { paidAmount: 1000 });
  assert.equal(r.state, 'held'); assert.match(r.reason, /charges \$3000 but \$2000 is due/);
});

test('missed days catch up, but only the latest stage (never a backlog)', () => {
  // cron didn't run on the due date; 1 day later still sends "due"
  assert.equal(ev('2026-11-21', {}, { sends: [sent('pre3')] }).stage, 'due');
  // first run ever is 4 days after due: sends over2 only (not pre3/due)
  const r = ev('2026-11-24');
  assert.equal(r.state, 'send'); assert.equal(r.stage, 'over2');
});

test('go-live: long-overdue instalments are not emailed automatically', () => {
  const r = ev('2026-12-20');
  assert.equal(r.state, 'missed');
});

test('adjusted due date restarts the schedule', () => {
  const oldSends = ['pre3', 'due'].map(s => sent(s, '2026-11-20'));
  const r = ev('2026-12-17', { due_date: '2026-12-20' }, { sends: oldSends });
  assert.equal(r.state, 'send'); assert.equal(r.stage, 'pre3');
});

test('auto reminders off, paused, client paused, closed: nothing sent', () => {
  assert.equal(ev('2026-11-20', {}, { settings: { auto_reminders: false } }).state, 'off');
  assert.equal(ev('2026-11-20', {}, { settings: { auto_reminders: true, paused: true } }).state, 'paused');
  assert.equal(ev('2026-11-20', {}, { client: { ...client, is_paused: true } }).state, 'client_paused');
  assert.equal(ev('2026-11-20', {}, { client: { ...client, is_closed: true } }).state, 'closed');
});

test('held: missing link, bad link, missing email, wrong currency, no due date', () => {
  assert.match(ev('2026-11-20', {}, { link: null }).reason, /No Whop payment link/);
  assert.match(ev('2026-11-20', {}, { link: { url: 'https://evil.com/pay' } }).reason, /not a secure whop.com link/);
  assert.match(ev('2026-11-20', {}, { client: { ...client, email: '' } }).reason, /Missing email address/);
  assert.match(ev('2026-11-20', {}, { link: { ...link, verified_currency: 'gbp' } }).reason, /GBP/);
  assert.equal(ev('2026-11-20', { due_date: null }).state, 'held');
});

test('email comes only from the client record, and a changed email holds reminders until confirmed', () => {
  assert.equal(ev('2026-11-20', {}, { settings: { ...on, reminder_email: 'other@x.com' } }).to_email, 'john@client.com');
  const changed = ev('2026-11-20', {}, { settings: { ...on, confirmed_email: 'old@client.com' } });
  assert.equal(changed.state, 'held'); assert.match(changed.reason, /Confirm it/);
  assert.equal(ev('2026-11-20', {}, { settings: { ...on, confirmed_email: 'JOHN@client.com' } }).state, 'send');
});

test('failed send is retried while the stage is current, then given up after 3 attempts', () => {
  const f1 = sent('due', '2026-11-20', 'failed', { id: 's1', attempts: 1 });
  const r1 = ev('2026-11-20', {}, { sends: [sent('pre3'), f1] });
  assert.equal(r1.state, 'send'); assert.equal(r1.retry_of.id, 's1');
  const f3 = sent('due', '2026-11-20', 'failed', { id: 's1', attempts: 3 });
  assert.equal(ev('2026-11-20', {}, { sends: [sent('pre3'), f3] }).state, 'scheduled');
});

test('uncertain send is never retried automatically', () => {
  const r = ev('2026-11-20', {}, { sends: [sent('pre3'), sent('due', '2026-11-20', 'uncertain')] });
  assert.equal(r.state, 'scheduled');
});

test('test-mode sends never count toward the live schedule', () => {
  const r = ev('2026-11-20', {}, { sends: [{ ...sent('pre3'), mode: 'test' }, { ...sent('due'), mode: 'test' }] });
  assert.equal(r.state, 'send'); assert.equal(r.stage, 'due');
});

test('preview: 14-day timeline lists each email once, on the right day', () => {
  const data = {
    clients: [client], instalments: [inst()], settings: { c1: on }, links: { i1: link }, paidByInstalment: {}, sends: [],
  };
  const t = simulateUpcoming(data, '2026-11-15', 14);
  assert.deepEqual(t.map(x => [x.date, x.stage]), [
    ['2026-11-17', 'pre3'], ['2026-11-20', 'due'], ['2026-11-22', 'over2'], ['2026-11-25', 'over5'], ['2026-11-27', 'over7'],
  ]);
  assert.equal(buildPlan(data, '2026-11-17').toSend.length, 1);
});

test('helpers', () => {
  assert.equal(firstName('john smith (GBP)'), 'John');
  assert.equal(firstName(''), 'there');
  assert.equal(extractPlanId('https://whop.com/checkout/plan_X1y2Z3/?d=1'), 'plan_X1y2Z3');
});

test('switching reminders on never back-fills reminders dated before that day', () => {
  // 9 days overdue, switched on today: no surprise "final reminder"
  const r = ev('2026-11-29', {}, { settings: { ...on, enabled_on: '2026-11-29' } });
  assert.equal(r.state, 'missed');
  // switched on 3 days before due: the schedule runs normally from there
  assert.equal(ev('2026-11-17', {}, { settings: { ...on, enabled_on: '2026-11-17' } }).stage, 'pre3');
  // switched on the day after due: skips "due", next is +2
  const late = ev('2026-11-21', {}, { settings: { ...on, enabled_on: '2026-11-21' } });
  assert.equal(late.state, 'scheduled'); assert.equal(late.next_stage, 'over2');
});
