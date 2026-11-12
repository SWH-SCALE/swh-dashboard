// Reminder email copy + MIME builder. Brand: SWH gold (#CCA732) on black.
// Copy rule: no em dashes.

import { formatLongDate } from './dates.js';
import { firstName, round2 } from './engine.js';

function money(n) {
  const v = round2(n);
  return '$' + v.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2,
  });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const COPY = {
  pre3: {
    subject: v => `Your instalment of ${v.amount} is due on ${v.dateShort}`,
    heading: 'Your next instalment is coming up',
    lines: v => [
      `Just a quick heads-up that your next instalment with Scaling With High Ticket is due in 3 days.`,
      `You can pay securely through Whop using the button below. It only takes a minute.`,
    ],
    cta: 'Pay my instalment',
  },
  due: {
    subject: v => `Your instalment of ${v.amount} is due today`,
    heading: 'Your instalment is due today',
    lines: v => [
      `A friendly reminder that your instalment with Scaling With High Ticket is due today.`,
      `You can pay securely through Whop using the button below.`,
    ],
    cta: 'Pay my instalment',
  },
  over2: {
    subject: v => `Your instalment of ${v.amount} is now overdue`,
    heading: 'Your instalment is now overdue',
    lines: v => [
      `We haven't yet received your instalment that was due on ${v.dateLong}.`,
      `If it has slipped through the cracks, you can pay securely through Whop using the button below. If something is holding it up, just reply to this email and we'll help.`,
    ],
    cta: 'Pay now',
  },
  over5: {
    subject: v => `Following up: instalment of ${v.amount} overdue`,
    heading: 'Following up on your overdue instalment',
    lines: v => [
      `Your instalment that was due on ${v.dateLong} is still outstanding.`,
      `Please settle it as soon as possible using the secure Whop link below, or reply to let us know when it will be paid.`,
    ],
    cta: 'Pay now',
  },
  over7: {
    subject: v => `Final reminder: instalment of ${v.amount} overdue`,
    heading: 'Final reminder',
    lines: v => [
      `This is our final automated reminder that your instalment due on ${v.dateLong} has not been received.`,
      `Please make payment today using the secure Whop link below. If you need to agree a different date, reply to this email and a member of our team will be in touch.`,
    ],
    cta: 'Pay now',
  },
};

/**
 * Build the reminder email for one instalment.
 * p: { stage, clientName, amountDue, amountTotal, amountPaid, dueDate, whopUrl, signOff, test }
 */
export function buildReminderEmail(p) {
  const c = COPY[p.stage] || COPY.due;
  const v = {
    name: firstName(p.clientName),
    amount: money(p.amountDue),
    dateLong: formatLongDate(p.dueDate),
    dateShort: formatLongDate(p.dueDate).replace(/^\w+,?\s/, '').replace(/\s\d{4}$/, ''),
  };
  const partial = p.amountPaid > 0
    ? `Thank you for the ${money(p.amountPaid)} already paid towards this instalment. The remaining balance is shown below.`
    : null;
  const subject = (p.test ? '[TEST] ' : '') + c.subject(v);
  const lines = c.lines(v);
  if (partial) lines.splice(1, 0, partial);

  const text = [
    `Hi ${v.name},`, '',
    ...lines.flatMap(l => [l, '']),
    `Amount due: ${v.amount} USD`,
    `Due date: ${v.dateLong}`, '',
    `Pay securely here: ${p.whopUrl}`, '',
    `If you've already paid, please ignore this email. Thank you.`, '',
    p.signOff, 'Scaling With High Ticket',
  ].join('\n');

  const gold = '#CCA732';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111111;">
  <tr><td style="background:#000000;padding:20px 28px;">
    <div style="font-size:13px;letter-spacing:3px;font-weight:800;color:#ffffff;">SCALING <span style="color:${gold};">WITH HIGH TICKET</span></div>
  </td></tr>
  ${p.test ? `<tr><td style="background:#fff7e0;color:#7a5b00;font-size:12px;padding:8px 28px;">TEST EMAIL. Only sent to the test inbox. No client received this.</td></tr>` : ''}
  <tr><td style="padding:32px 28px 8px;">
    <div style="font-size:22px;font-weight:700;line-height:1.3;margin:0 0 18px;">${esc(c.heading)}</div>
    <p style="font-size:15px;line-height:1.6;margin:0 0 14px;">Hi ${esc(v.name)},</p>
    ${lines.map(l => `<p style="font-size:15px;line-height:1.6;margin:0 0 14px;">${esc(l)}</p>`).join('')}
  </td></tr>
  <tr><td style="padding:4px 28px 4px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ececec;border-radius:8px;">
      <tr><td style="padding:14px 18px;font-size:13px;color:#666666;">Amount due</td>
          <td align="right" style="padding:14px 18px;font-size:18px;font-weight:700;">${esc(v.amount)} USD</td></tr>
      <tr><td style="padding:0 18px 14px;font-size:13px;color:#666666;">Due date</td>
          <td align="right" style="padding:0 18px 14px;font-size:14px;font-weight:600;">${esc(v.dateLong)}</td></tr>
    </table>
  </td></tr>
  <tr><td align="center" style="padding:24px 28px 8px;">
    <a href="${esc(p.whopUrl)}" style="display:inline-block;background:${gold};color:#000000;text-decoration:none;font-weight:700;font-size:15px;padding:14px 30px;border-radius:8px;">${esc(c.cta)}</a>
    <div style="font-size:12px;color:#888888;margin-top:12px;line-height:1.5;">Secure checkout by Whop. If the button doesn't work, copy this link:<br><a href="${esc(p.whopUrl)}" style="color:#888888;word-break:break-all;">${esc(p.whopUrl)}</a></div>
  </td></tr>
  <tr><td style="padding:20px 28px 28px;">
    <p style="font-size:13px;line-height:1.6;color:#555555;margin:0 0 16px;">If you've already paid, please ignore this email. Thank you.</p>
    <p style="font-size:15px;line-height:1.5;margin:0;">${esc(p.signOff)}<br><span style="color:#888888;font-size:13px;">Scaling With High Ticket</span></p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  return { subject, text, html };
}

// ── MIME (RFC 2822) for the Gmail API ─────────────────────────────
function encodeHeader(s) {
  // RFC 2047 for anything non-ASCII; strip CR/LF to prevent header injection
  const clean = String(s).replace(/[\r\n]+/g, ' ');
  return /^[\x20-\x7E]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

function b64lines(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
}

export function buildMime({ fromName, fromEmail, to, replyTo, subject, text, html }) {
  for (const addr of [fromEmail, to, replyTo].filter(Boolean)) {
    if (/[\r\n<>,;]/.test(addr)) throw new Error('Invalid email address');
  }
  const boundary = 'swh_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const headers = [
    `From: ${encodeHeader(fromName)} <${fromEmail}>`,
    `To: ${to}`,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean);
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64', '',
    b64lines(text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64', '',
    b64lines(html),
    `--${boundary}--`, '',
  ];
  return headers.join('\r\n') + '\r\n\r\n' + body.join('\r\n');
}

export function toBase64Url(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
