import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReminderEmail, buildMime } from '../api/_lib/email.js';
import { verifyWebhook } from '../api/_lib/whop.js';

process.env.TOKEN_ENCRYPTION_KEY = 'k'.repeat(48);
const { encrypt, decrypt, signState, verifyState } = await import('../api/_lib/crypto.js');

const base = { clientName: 'John Smith', amountDue: 3000, amountTotal: 3000, amountPaid: 0, dueDate: '2026-11-23', whopUrl: 'https://whop.com/checkout/plan_A/', signOff: 'The SWH Team' };

test('every stage renders, personalised, with link, amount, date and no em dashes', () => {
  for (const stage of ['pre3', 'due', 'over2', 'over5', 'over7']) {
    const e = buildReminderEmail({ ...base, stage });
    for (const part of [e.subject, e.text, e.html]) {
      assert.ok(!part.includes('—') && !part.includes('–'), `dash in ${stage}`);
    }
    assert.match(e.text, /Hi John,/);
    assert.match(e.text, /\$3,000 USD/);
    assert.match(e.text, /23 November 2026/);
    assert.match(e.html, /href="https:\/\/whop\.com\/checkout\/plan_A\/"/);
  }
  assert.match(buildReminderEmail({ ...base, stage: 'pre3' }).subject, /due on 23 November$/);
  assert.match(buildReminderEmail({ ...base, stage: 'due', test: true }).subject, /^\[TEST\] /);
});

test('client name and link are HTML-escaped', () => {
  const e = buildReminderEmail({ ...base, stage: 'due', clientName: '<script>x</script>', whopUrl: 'https://whop.com/a"onmouseover="x' });
  assert.ok(!e.html.includes('<script>x'));
  assert.ok(!e.html.includes('"onmouseover'));
});

test('MIME: headers safe from injection, non-ASCII subject encoded', () => {
  assert.throws(() => buildMime({ fromName: 'SWH', fromEmail: 'a@b.com', to: 'x@y.com\r\nBcc: evil@z.com', subject: 's', text: 't', html: 'h' }));
  const m = buildMime({ fromName: 'SWH', fromEmail: 'a@b.com', to: 'x@y.com', subject: 'Payé\r\nBcc: e@e.com', text: 't', html: 'h' });
  assert.match(m, /Subject: =\?UTF-8\?B\?/);
  assert.ok(!/^Bcc:/m.test(m));
});

test('refresh token encryption round-trips and detects tampering', () => {
  const blob = encrypt('1//refresh-token-value');
  assert.ok(!blob.includes('refresh-token-value'));
  assert.equal(decrypt(blob), '1//refresh-token-value');
  const parts = blob.split('.'); parts[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() => decrypt(parts.join('.')));
});

test('OAuth state is signed and expires', () => {
  const s = signState({ r: 'https://x/api/gmail-auth' });
  assert.equal(verifyState(s).r, 'https://x/api/gmail-auth');
  assert.equal(verifyState(s.slice(0, -2) + 'xx'), null);
  assert.equal(verifyState(signState({ r: 'x' }, -10)), null);
});

test('webhook signature accepts multiple v1 signatures (secret rotation)', async () => {
  const crypto = await import('node:crypto');
  const body = '{"a":1}'; const ts = 1795000000;
  const sig = crypto.createHmac('sha256', Buffer.from('ws_new')).update(`id.${ts}.${body}`).digest('base64');
  const h = { 'webhook-id': 'id', 'webhook-timestamp': String(ts), 'webhook-signature': `v1,AAAA v1,${sig}` };
  assert.equal(verifyWebhook(body, h, 'ws_new', ts).ok, true);
});
