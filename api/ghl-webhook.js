// /api/ghl-webhook.js
// Receives webhooks from GoHighLevel pipeline stage changes.
// PERMISSIVE VERSION: logs everything, never errors with 4xx/5xx, extracts fields from any payload shape.

const SUPABASE_URL = 'https://qstlyvauppjkdiwpgtql.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const STAGE_MAP = {
  'new lead':                      { status: null,        outcome: null },
  'contacted':                     { status: null,        outcome: null },
  'call back':                     { status: null,        outcome: null },
  'unqualified':                   { status: null,        outcome: 'notqualified' },
  'no answer 1':                   { status: null,        outcome: null },
  'no answer 2':                   { status: null,        outcome: null },
  'no answer 3 | weekly outreach': { status: null,        outcome: null },
  'tcc purchased':                 { status: null,        outcome: null },
  'call booked':                   { status: 'scheduled', outcome: null },
  'no show':                       { status: 'no_show',   outcome: 'noshow' },
  'cancelled':                     { status: 'cancelled', outcome: null },
  'call completed':                { status: 'showed',    outcome: 'followup' },
  'deposit':                       { status: 'showed',    outcome: 'closed' },
  'closed - won (cash collected)': { status: 'showed',    outcome: 'closed' },
  'offered - follow up':           { status: 'showed',    outcome: 'followup' },
  'deal lost':                     { status: 'showed',    outcome: 'lost' },
};

// Recursively search an object for any of the candidate keys (case-insensitive)
function deepFind(obj, candidates) {
  if (!obj || typeof obj !== 'object') return '';
  const lowerCandidates = candidates.map(c => c.toLowerCase());

  for (const key of Object.keys(obj)) {
    if (lowerCandidates.includes(key.toLowerCase())) {
      const val = obj[key];
      if (val !== null && val !== undefined && val !== '') {
        return String(val);
      }
    }
  }

  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const found = deepFind(val, candidates);
      if (found) return found;
    }
  }

  return '';
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'SWH GHL Webhook Receiver (permissive)',
      stage_map_size: Object.keys(STAGE_MAP).length,
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const payload = req.body || {};
  console.log('=== GHL WEBHOOK RECEIVED ===');
  console.log('Full payload:', JSON.stringify(payload, null, 2));
  console.log('Top-level keys:', Object.keys(payload));

  try {
    const email = deepFind(payload, ['email', 'contact_email', 'contactEmail']).toLowerCase().trim();
    const phone = deepFind(payload, ['phone', 'contact_phone', 'contactPhone', 'phoneNumber', 'phone_number']);
    const firstName = deepFind(payload, ['first_name', 'firstName', 'first', 'firstname']);
    const lastName  = deepFind(payload, ['last_name', 'lastName', 'last', 'lastname']);
    const fullName  = deepFind(payload, ['full_name', 'fullName', 'name', 'contact_name', 'contactName']);
    const name = fullName || `${firstName} ${lastName}`.trim();
    const contactId = deepFind(payload, ['contact_id', 'contactId', 'id', 'contactID']);
    const stageRaw = deepFind(payload, [
      'pipeline_stage', 'pipelineStage', 'stage', 'stage_name', 'stageName',
      'opportunity_stage', 'opportunityStage', 'new_stage', 'newStage',
      'current_stage', 'currentStage'
    ]);
    const stageKey = stageRaw.trim().toLowerCase();
    const pipelineName = deepFind(payload, ['pipeline_name', 'pipelineName', 'pipeline']);

    console.log('Extracted fields:', { email, phone, name, contactId, stageRaw, pipelineName });

    if (!email && !contactId) {
      return res.status(200).json({
        ok: true,
        action: 'skipped_no_identifier',
        received_keys: Object.keys(payload),
      });
    }

    if (!stageRaw) {
      return res.status(200).json({
        ok: true,
        action: 'skipped_no_stage',
        received_keys: Object.keys(payload),
        email,
        contactId,
      });
    }

    const mapping = STAGE_MAP[stageKey];

    const patch = {
      ghl_pipeline_stage: stageRaw,
      last_stage_change_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (contactId) patch.ghl_contact_id = contactId;
    if (mapping && mapping.status) patch.status = mapping.status;
    if (mapping && mapping.outcome) patch.outcome = mapping.outcome;

    let matchUrl;
    if (email) {
      matchUrl = `${SUPABASE_URL}/rest/v1/booked_calls?email=ilike.${encodeURIComponent(email)}`;
    } else {
      matchUrl = `${SUPABASE_URL}/rest/v1/booked_calls?ghl_contact_id=eq.${encodeURIComponent(contactId)}`;
    }

    const lookupRes = await fetch(matchUrl, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    });

    if (!lookupRes.ok) {
      const err = await lookupRes.text();
      console.error('Supabase lookup failed:', err);
      return res.status(200).json({ ok: true, action: 'lookup_failed', error: err });
    }

    const matches = await lookupRes.json();

    if (matches.length === 0) {
      console.log('No booked_calls match for:', { email, contactId });
      return res.status(200).json({
        ok: true,
        action: 'no_match',
        email,
        stage: stageRaw,
      });
    }

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
      console.error('Supabase update failed:', err);
      return res.status(200).json({ ok: true, action: 'update_failed', error: err });
    }

    console.log('Successfully updated booked_calls row:', targetRow.id);
    return res.status(200).json({
      ok: true,
      action: 'updated',
      row_id: targetRow.id,
      email,
      stage: stageRaw,
      patch,
    });

  } catch (e) {
    console.error('GHL webhook handler error:', e);
    return res.status(200).json({ ok: true, action: 'error_caught', message: e.message });
  }
}
