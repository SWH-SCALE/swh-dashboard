// /api/calendly-webhook.js
// Receives webhooks from Calendly and writes bookings to Supabase.
// Handles: invitee.created (new booking) and invitee.canceled (cancellation).

const SUPABASE_URL = 'https://qstlyvauppjkdiwpgtql.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY; // set in Vercel env vars

export default async function handler(req, res) {
  // Health check — visiting the URL in a browser shows it's alive
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'SWH Calendly Webhook Receiver',
      message: 'POST a Calendly webhook payload to this URL',
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = req.body;
    const event = payload?.event; // 'invitee.created' or 'invitee.canceled'
    const invitee = payload?.payload;

    if (!event || !invitee) {
      console.error('Invalid Calendly payload:', JSON.stringify(payload).slice(0, 500));
      return res.status(400).json({ error: 'Invalid payload shape' });
    }

    // Extract the fields we care about
    const calendlyEventUri = invitee?.event?.uri || invitee?.uri;
    const name  = invitee?.name || '';
    const email = invitee?.email || '';
    const scheduledAt = invitee?.scheduled_event?.start_time || invitee?.event?.start_time;
    const eventType   = invitee?.scheduled_event?.event_type || invitee?.event?.event_type || '';

    // Determine closer from round robin assignment
    // Calendly puts the assigned host in event_memberships
    const memberships = invitee?.scheduled_event?.event_memberships || [];
    let closer = '';
    for (const m of memberships) {
      const userEmail = (m?.user_email || '').toLowerCase();
      if (userEmail.includes('frankie')) { closer = 'Frankie'; break; }
      if (userEmail.includes('mehdi'))   { closer = 'Mehdi';   break; }
    }

    // Pull phone from custom questions if you ask for it on Calendly
    let phone = '';
    const questions = invitee?.questions_and_answers || [];
    for (const q of questions) {
      const qText = (q?.question || '').toLowerCase();
      if (qText.includes('phone') || qText.includes('number') || qText.includes('mobile')) {
        phone = q?.answer || '';
        break;
      }
    }

    // Handle cancellation
    if (event === 'invitee.canceled') {
      const cancelReason = invitee?.cancellation?.reason || invitee?.cancel_url || 'Cancelled';
      const updateRes = await fetch(
        `${SUPABASE_URL}/rest/v1/booked_calls?calendly_event_uri=eq.${encodeURIComponent(calendlyEventUri)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
          },
          body: JSON.stringify({
            status: 'cancelled',
            cancellation_reason: cancelReason,
            updated_at: new Date().toISOString(),
          }),
        }
      );
      if (!updateRes.ok) {
        const err = await updateRes.text();
        console.error('Cancel patch failed:', err);
        return res.status(500).json({ error: 'Cancel update failed', detail: err });
      }
      return res.status(200).json({ ok: true, action: 'cancelled', uri: calendlyEventUri });
    }

    // Handle new booking (invitee.created)
    if (event === 'invitee.created') {
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/booked_calls`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=representation',
        },
        body: JSON.stringify({
          calendly_event_uri: calendlyEventUri,
          name,
          email,
          phone,
          scheduled_at: scheduledAt,
          booked_at: new Date().toISOString(),
          closer,
          event_type: eventType,
          source: 'Calendly',
          status: 'scheduled',
          raw_payload: payload,
        }),
      });
      if (!insertRes.ok) {
        const err = await insertRes.text();
        console.error('Insert failed:', err);
        return res.status(500).json({ error: 'Insert failed', detail: err });
      }
      return res.status(200).json({ ok: true, action: 'booked', uri: calendlyEventUri, closer, name });
    }

    // Unknown event type — log and acknowledge so Calendly doesn't retry
    console.log('Unhandled event type:', event);
    return res.status(200).json({ ok: true, action: 'ignored', event });

  } catch (e) {
    console.error('Webhook handler error:', e);
    return res.status(500).json({ error: 'Server error', message: e.message });
  }
}
