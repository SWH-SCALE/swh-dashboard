// Daily reminder run. Safe to trigger any number of times:
//  1. a database lock stops two runs overlapping
//  2. each reminder is "claimed" in reminder_sends before the email goes out;
//     the unique index means a second claim for the same stage fails
//  3. payment status is re-checked right before each email

import crypto from 'node:crypto';
import { settings, whopLinkConfig, MAX_SEND_ATTEMPTS, MAX_SENDS_PER_RUN, AMOUNT_TOLERANCE, STAGES } from './config.js';
import { ensureLink as realEnsureLink, retireLink as realRetireLink } from './links.js';
import { todayIn } from './dates.js';
import { buildPlan } from './engine.js';
import { buildReminderEmail } from './email.js';

const stageLabel = k => (STAGES.find(s => s.key === k) || {}).label || k;

/**
 * deps: { store, send(gmailRow, msg) => {id}, now?: Date, live?: boolean, trigger?: string }
 */
export async function runReminders({ store, send, now = new Date(), live, trigger = 'cron', ensureLink = realEnsureLink, retireLink = realRetireLink }) {
  const cfg = settings();
  const isLive = live ?? cfg.live;
  const today = todayIn(cfg.timezone, now);
  const holder = crypto.randomUUID();
  const summary = { today, mode: isLive ? 'live' : 'test', trigger, sent: 0, failed: 0, held: 0, skipped_duplicate: 0, would_send: [], errors: [] };

  if (!(await store.claimLock('payment-reminders', holder, 600))) {
    summary.locked = true;
    await store.log({ level: 'warn', event: 'run_skipped', message: 'Another reminder run is already in progress. This run did nothing.' });
    return summary;
  }

  try {
    if (isLive) {
      const stale = await store.markStaleSending(15);
      for (const s of stale || []) {
        await store.log({ level: 'warn', event: 'reminder_uncertain', client_id: s.client_id, instalment_id: s.instalment_id,
          message: `A ${stageLabel(s.stage)} email to ${s.to_email} may not have gone out. Check Gmail Sent before resending.` });
      }
    }

    const data = await store.loadAll();
    const autoLinks = whopLinkConfig().enabled;
    const plan = buildPlan(data, today, { autoLinks });

    // Switch off generated Whop links for instalments that are now paid
    // (e.g. ticked paid by hand), so they can't be paid twice.
    for (const it of plan.items) {
      const l = data.links[it.instalment_id];
      if (it.state === 'paid' && l && l.source === 'generated' && !l.retired_at) {
        await retireLink(store, it.instalment_id).catch(() => {});
      }
    }
    summary.held = plan.items.filter(i => i.state === 'held' && i.stage).length;
    const toSend = plan.toSend;

    if (!isLive) {
      summary.would_send = toSend.map(i => ({ to: i.to_email, client: i.client_name, instalment: i.instalment_number, stage: i.stage, amount: i.amount_due, link: i.link_action ? 'created automatically' : 'saved link' }));
      await store.log({
        event: 'dry_run',
        message: `Test mode: ${toSend.length} reminder(s) would be sent today${toSend.length ? ': ' + toSend.map(i => `${i.client_name} (${stageLabel(i.stage)})`).join(', ') : ''}. No client emails sent.`,
        details: { today, would_send: summary.would_send },
      });
      return summary;
    }

    const gmail = data.gmail;
    if (!gmail || gmail.status !== 'connected') {
      await store.log({ level: 'error', event: 'run_blocked', message: `Gmail is not connected, so ${toSend.length} reminder(s) were not sent. Connect Gmail on the Retainers tab.` });
      summary.errors.push('gmail_not_connected');
      return summary;
    }

    let count = 0;
    for (const item of toSend) {
      if (count >= MAX_SENDS_PER_RUN) {
        await store.log({ level: 'warn', event: 'run_capped', message: `Safety cap of ${MAX_SENDS_PER_RUN} emails per run reached. Remaining reminders will go out on the next run.` });
        break;
      }

      // Claim this stage. If another run already claimed it, skip.
      let claim;
      if (item.retry_of) {
        if ((item.retry_of.attempts || 1) >= MAX_SEND_ATTEMPTS) continue;
        claim = await store.reclaimFailed(item.retry_of.id, (item.retry_of.attempts || 1) + 1);
      } else {
        claim = await store.claimSend({
          instalment_id: item.instalment_id, client_id: item.client_id, due_date: item.due_date,
          stage: item.stage, mode: 'live', status: 'sending', to_email: item.to_email,
          amount_usd: item.amount_due, whop_url: item.whop_url,
        });
      }
      if (!claim) { summary.skipped_duplicate++; continue; }
      count++;

      // Last-second check: has it been paid since the run started?
      const fresh = await store.getInstalment(item.instalment_id);
      const paidSoFar = await store.ledgerSum(item.instalment_id);
      if (!fresh || fresh.paid === true || Number(fresh.amount_usd) - paidSoFar <= AMOUNT_TOLERANCE) {
        await store.updateSend(claim.id, { status: 'cancelled', last_error: 'Paid before the email was sent' });
        await store.log({ event: 'reminder_cancelled', client_id: item.client_id, instalment_id: item.instalment_id, message: `${item.client_name}: paid moments before the reminder, so nothing was sent.` });
        continue;
      }
      item.amount_due = Math.round((Number(fresh.amount_usd) - paidSoFar) * 100) / 100;
      item.amount_paid = paidSoFar;

      // Create (or refresh) the Whop link for the exact amount due, if needed
      if (item.link_action) {
        try {
          const inst = fresh;
          const client = data.clients.find(c => String(c.id) === String(item.client_id));
          const r = await ensureLink(store, { inst, client, amountDue: item.amount_due });
          item.whop_url = r.link.url;
          await store.updateSend(claim.id, { whop_url: item.whop_url });
        } catch (e) {
          await store.updateSend(claim.id, { status: 'failed', last_error: `Whop link: ${e.message}` });
          await store.log({ level: 'error', event: 'reminder_failed', client_id: item.client_id, instalment_id: item.instalment_id,
            message: `${item.client_name}: could not create the Whop link, so no email was sent (${e.message}). Will retry next run.` });
          summary.failed++;
          continue;
        }
      }

      const email = buildReminderEmail({
        stage: item.stage, clientName: item.client_name, amountDue: item.amount_due,
        amountTotal: item.amount_total, amountPaid: item.amount_paid, dueDate: item.due_date,
        whopUrl: item.whop_url, signOff: cfg.signOff,
      });

      try {
        const res = await send(gmail, { to: item.to_email, ...email });
        await store.updateSend(claim.id, { status: 'sent', sent_at: new Date().toISOString(), gmail_message_id: res?.id || null, subject: email.subject, last_error: null });
        await store.log({ event: 'reminder_sent', client_id: item.client_id, instalment_id: item.instalment_id,
          message: `Sent "${stageLabel(item.stage)}" reminder to ${item.client_name} <${item.to_email}> for $${item.amount_due} due ${item.due_date}.`,
          details: { stage: item.stage, gmail_message_id: res?.id || null } });
        summary.sent++;
      } catch (e) {
        const uncertain = e.kind === 'uncertain';
        await store.updateSend(claim.id, { status: uncertain ? 'uncertain' : 'failed', last_error: e.message, subject: email.subject });
        await store.log({ level: 'error', event: uncertain ? 'reminder_uncertain' : 'reminder_failed', client_id: item.client_id, instalment_id: item.instalment_id,
          message: `${uncertain ? 'Unclear if sent' : 'Failed to send'} "${stageLabel(item.stage)}" reminder to ${item.client_name} <${item.to_email}>: ${e.message}`,
          details: { attempts: claim.attempts || 1, kind: e.kind || null } });
        summary.failed++;
        if (e.kind === 'auth') { summary.errors.push('gmail_auth'); break; } // stop: every send would fail
      }
    }

    await store.log({ event: 'run_finished', message: `Daily run (${trigger}): ${summary.sent} sent, ${summary.failed} failed, ${summary.held} held.`, details: summary });
    return summary;
  } catch (e) {
    summary.errors.push(e.message);
    await store.log({ level: 'error', event: 'run_error', message: `Reminder run crashed: ${e.message}` });
    throw e;
  } finally {
    await store.releaseLock('payment-reminders', holder).catch(() => {});
  }
}
