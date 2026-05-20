// /api/calendly-webhook.js
// Receives webhooks from Calendly and writes bookings to Supabase `calls` table.
// Handles: invitee.created (new booking) and invitee.canceled (cancellation or reschedule).
//
// Single source of truth: the `calls` table. The dashboard reads from
// the `calls_with_status` view which derives effective_status from the
// stage field + manual_outcome.

const SUPABASE_URL = 'https://qstlyvauppjkdiwpgtql.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

// Internal team emails — bookings from these auto-flag as test
const INTERNAL_EMAILS = new Set([
  'ms10.2004.09@gmail.com',
  'mehdimullionz@gmail.com',
  'mentormehdi@gmail.com',
  'zmsyed2004@gmail.com',
  'zanib.fiverr@gmail.com',
  'shetalksaboutit@gmail.com',
  'zsyedwep@theparkfederation.org',
  'test@services.com',
  'rentester123@gmail.com',
]);

// Test detection by name patterns (catches one-off test bookings)
const TEST_NAME_PATTERNS = ['test', 'testing'];

function detectIsTest(email, name) {
  const em = (email || '').toLowerCase().trim();
  if (INTERNAL_EMAILS.has(em)) return true;
  const nm = (name || '').toLowerCase();
  return TEST_NAME_PATTERNS.some(p => nm.includes(p));
}

function detectCloser(memberships, fallbackUserEmail) {
  const candidates = [];
  for (const m of memberships || []) {
    if (m?.user_email) candidates.push(m.user_email.toLowerCase());
  }
  if (fallbackUserEmail) candidates.push(fallbackUserEmail.toLowerCase());

  for (const em of candidates) {
    if (em.includes('frankie')) return 'Frankie';
    if (em.includes('mehdi'))   return 'Mehdi';
    if (em.includes('salima'))  return 'Salima';
    if (em.includes('zain'))    return 'Zain';
  }
  return null;
}

export default async function handler(req, res) {
  // Health check
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'SWH Calendly Webhook Receiver',
      target_table: 'calls',
      message: 'POST a Calendly webhook payload to this URL',
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = req.body;
    const event = payload?.event;        // 'invitee.created' or 'invitee.canceled'
    const invitee = payload?.payload;

    if (!event || !invitee) {
      console.error('Invalid Calendly payload:', JSON.stringify(payload).slice(0, 500));
      return res.status(400).json({ error: 'Invalid payload shape' });
    }

    // ---- Extract canonical fields ----
    const scheduledEvent = invitee?.scheduled_event || invitee?.event || {};
    const calendlyEventUri = scheduledEvent?.uri || invitee?.event?.uri;
    const calendlyInviteeUri = invitee?.uri;

    const name  = (invitee?.name || '').trim();
    const email = (invitee?.email || '').trim().toLowerCase();
    const scheduledAt = scheduledEvent?.start_time;
    const eventEndAt  = scheduledEvent?.end_time;
    const eventType   = scheduledEvent?.event_type || '';

    if (!calendlyEventUri || !email || !scheduledAt) {
      console.error('Missing required fields:', { calendlyEventUri, email, scheduledAt });
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Closer
    const memberships = scheduledEvent?.event_memberships || [];
    const closer = detectCloser(memberships, invitee?.user_email);

    // Phone
    let phone = '';
    const questions = invitee?.questions_and_answers || [];
    for (const q of questions) {
      const qText = (q?.question || '').toLowerCase();
      if (qText.includes('phone') || qText.includes('number') || qText.includes('mobile')) {
        phone = q?.answer || '';
        break;
      }
    }

    // Reschedule detection: Calendly puts `rescheduled: true` on the cancel
    // payload when the cancellation is part of a reschedule flow.
    const isReschedule = invitee?.rescheduled === true || invitee?.cancellation?.canceled_by_type === 'invitee_reschedule';

    // ---- Handle cancellation (or reschedule) ----
    if (event === 'invitee.canceled') {
      const newStage = isReschedule ? 'RESCHEDULED' : 'CANCELLED';
      const cancelReason = invitee?.cancellation?.reason || (isReschedule ? 'Rescheduled' : 'Cancelled');

      const updateRes = await fetch(
        `${SUPABASE_URL}/rest/v1/calls?calendly_event_uri=eq.${encodeURIComponent(calendlyEventUri)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
          },
          body: JSON.stringify({
            stage: newStage,
            cancellation_reason: cancelReason,
          }),
        }
      );
      if (!updateRes.ok) {
        const err = await updateRes.text();
        console.error('Cancel/reschedule patch failed:', err);
        return res.status(500).json({ error: 'Update failed', detail: err });
      }
      return res.status(200).json({
        ok: true,
        action: isReschedule ? 'rescheduled' : 'cancelled',
        uri: calendlyEventUri,
      });
    }

    // ---- Handle new booking ----
    if (event === 'invitee.created') {
      const isTest = detectIsTest(email, name);

      const row = {
        calendly_event_uri: calendlyEventUri,
        calendly_invitee_uri: calendlyInviteeUri,
        invitee_name: name,
        invitee_email: email,
        phone: phone || null,
        scheduled_at: scheduledAt,
        event_end_at: eventEndAt || null,
        booked_at: new Date().toISOString(),
        closer: closer,
        event_type: eventType,
        stage: 'BOOKED',
        is_test: isTest,
        source: 'calendly_webhook',
        raw_payload: payload,
      };

      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/calls`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=representation',
        },
        body: JSON.stringify(row),
      });

      if (!insertRes.ok) {
        const err = await insertRes.text();
        console.error('Insert failed:', err);
        return res.status(500).json({ error: 'Insert failed', detail: err });
      }

      return res.status(200).json({
        ok: true,
        action: 'booked',
        uri: calendlyEventUri,
        closer,
        name,
        is_test: isTest,
      });
    }

    // Unknown event type — ack so Calendly doesn't retry
    console.log('Unhandled event type:', event);
    return res.status(200).json({ ok: true, action: 'ignored', event });

  } catch (e) {
    console.error('Webhook handler error:', e);
    return res.status(500).json({ error: 'Server error', message: e.message });
  }
}
