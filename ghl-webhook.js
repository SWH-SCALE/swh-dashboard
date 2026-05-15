// /api/ghl-webhook.js
// Receives webhooks from GoHighLevel pipeline stage changes.
// Matches contacts to existing booked_calls rows by email and updates status + outcome.

const SUPABASE_URL = 'https://qstlyvauppjkdiwpgtql.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY; // shared with calendly-webhook

// Maps GHL pipeline stage names → dashboard status + outcome.
// These names MUST match exactly what's in your GHL pipeline (case-sensitive after .trim().toLowerCase()).
const STAGE_MAP = {
  // Pre-call stages (do nothing — Calendly already handled these)
  'new lead':                            { status: null, outcome: null }, // skip
  'contacted':                           { status: null, outcome: null }, // skip
  'call back':                           { status: null, outcome: null }, // skip
  'unqualified':                         { status: null, outcome: 'notqualified' },
  'no answer 1':                         { status: null, outcome: null }, // skip
  'no answer 2':                         { status: null, outcome: null }, // skip
  'no answer 3 | weekly outreach':       { status: null, outcome: null }, // skip
  'tcc purchased':                       { status: null, outcome: null }, // skip
  'call booked':                         { status: 'scheduled', outcome: null },

  // Post-call stages — the ones we actually care about
  'no show':                             { status: 'no_show',  outcome: 'noshow' },
  'cancelled':                           { status: 'cancelled',outcome: null },
  'call completed':                      { status: 'showed',   outcome: 'followup' },     // default if no specific outcome yet
  'deposit':                             { status: 'showed',   outcome: 'closed' },        // partial close
  'closed - won (cash collected)':       { status: 'showed',   outcome: 'closed' },
  'offered - follow up':                 { status: 'showed',   outcome: 'followup' },
  'deal lost':                           { status: 'showed',   outcome: 'lost' },
};

export default async function handler(req, res) {
  // Health check
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'SWH GHL Webhook Receiver',
      message: 'POST a GHL workflow webhook payload to this URL',
      stage_map_size: Object.keys(STAGE_MAP).length,
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = req.body;

    // GHL workflow webhooks send a flat-ish payload. Fields vary depending on the workflow setup.
    // We look for the most common field names. If a field is missing, we just skip it.
    const email   = (payload?.email || payload?.contact_email || payload?.contact?.email || '').toLowerCase().trim();
    const phone   = payload?.phone || payload?.contact_phone || payload?.contact?.phone || '';
    const name    = payload?.full_name || payload?.name || payload?.contact_name || `${payload?.first_name||''} ${payload?.last_name||''}`.trim();
    const contactId = payload?.contact_id || payload?.id || payload?.contact?.id || '';
    const stageRaw  = payload?.pipeline_stage || payload?.stage || payload?.opportunity_stage || payload?.new_stage || '';
    const stageKey  = stageRaw.trim().toLowerCase();

    if (!email && !contactId) {
      console.error('GHL payload missing both email and contact_id:', JSON.stringify(payload).slice(0, 500));
      return res.status(400).json({ error: 'Missing identifier — need email or contact_id' });
    }

    if (!stageKey) {
      console.error('GHL payload missing pipeline_stage:', JSON.stringify(payload).slice(0, 500));
      return res.status(400).json({ error: 'Missing pipeline_stage in payload' });
    }

    const mapping = STAGE_MAP[stageKey];
    if (!mapping) {
      console.log('Unmapped stage (will store but not change status):', stageRaw);
      // We still update ghl_pipeline_stage so we can see it in the dashboard
    }

    // Build patch payload — only include fields we have values for
    const patch = {
      ghl_pipeline_stage: stageRaw,
      last_stage_change_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (contactId) patch.ghl_contact_id = contactId;
    if (mapping && mapping.status) patch.status = mapping.status;
    if (mapping && mapping.outcome) patch.outcome = mapping.outcome;

    // Try matching by email first (since user confirmed same email everywhere)
    let matchUrl = null;
    if (email) {
      matchUrl = `${SUPABASE_URL}/rest/v1/booked_calls?email=ilike.${encodeURIComponent(email)}`;
    } else if (contactId) {
      matchUrl = `${SUPABASE_URL}/rest/v1/booked_calls?ghl_contact_id=eq.${encodeURIComponent(contactId)}`;
    }

    // Look up matching rows
    const lookupRes = await fetch(matchUrl, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    });

    if (!lookupRes.ok) {
      const err = await lookupRes.text();
      console.error('Lookup failed:', err);
      return res.status(500).json({ error: 'Supabase lookup failed', detail: err });
    }

    const matches = await lookupRes.json();

    if (matches.length === 0) {
      // No matching booked call found. This is normal for contacts that never booked via Calendly
      // (e.g. organic leads that became opportunities). We could optionally insert a row here,
      // but for now we just log and acknowledge.
      console.log('No booked_calls match for email/contact_id:', { email, contactId, stage: stageRaw });
      return res.status(200).json({
        ok: true,
        action: 'no_match',
        message: 'No matching booked call found for this contact. Stage change logged but no row updated.',
        email,
        stage: stageRaw,
      });
    }

    // Update all matching rows (usually just 1, but handle multiple if a contact rebooked)
    // We update the MOST RECENT row to avoid overwriting old call history
    matches.sort((a, b) => new Date(b.scheduled_at || b.created_at) - new Date(a.scheduled_at || a.created_at));
    const targetRow = matches[0];

    const updateRes = await fetch(
      `${SUPABASE_URL}/rest/v1/booked_calls?id=eq.${targetRow.id}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        body: JSON.stringify(patch),
      }
    );

    if (!updateRes.ok) {
      const err = await updateRes.text();
      console.error('Update failed:', err);
      return res.status(500).json({ error: 'Supabase update failed', detail: err });
    }

    return res.status(200).json({
      ok: true,
      action: 'updated',
      row_id: targetRow.id,
      email,
      stage: stageRaw,
      patch,
      additional_matches: matches.length - 1,
    });

  } catch (e) {
    console.error('GHL webhook handler error:', e);
    return res.status(500).json({ error: 'Server error', message: e.message });
  }
}
