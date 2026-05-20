// /api/ghl-webhook.js
// Receives webhooks from GoHighLevel pipeline stage changes.
// PERMISSIVE: logs everything, never returns 4xx/5xx, extracts fields from any payload shape.
//
// Writes to public.calls (the new single source of truth).
// Matches by email → most recent call whose scheduled_at is in the past
// (or the only call, if there's just one). Future calls are not updated
// because GHL outcome stages can only describe calls that have happened.

const SUPABASE_URL = 'https://qstlyvauppjkdiwpgtql.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

// GHL stage (lowercased) → action on the calls row
//   stage: which value to write to calls.stage
//   note:  optional manual_outcome_note (for pre-call stages, so the
//          dashboard surface explains why a call is NO_SHOW even though
//          the GHL stage doesn't say "No Show")
const STAGE_MAP = {
  // Post-call outcomes → SHOWED
  'call completed':                { stage: 'SHOWED',  note: null },
  'deposit':                       { stage: 'SHOWED',  note: null },
  'closed - won (cash collected)': { stage: 'SHOWED',  note: null },
  'offered - follow up':           { stage: 'SHOWED',  note: null },
  'deal lost':                     { stage: 'SHOWED',  note: null },

  // Explicit no-show / cancel
  'no show':                       { stage: 'NO_SHOW', note: null },
  'cancelled':                     { stage: 'CANCELLED', note: null },

  // Pre-call funnel stages → NO_SHOW per pipeline rule (a real call
  // would have moved past these to a post-call outcome)
  'unqualified':                   { stage: 'NO_SHOW', note: 'GHL stage: Unqualified (pre-call rule)' },
  'tcc purchased':                 { stage: 'NO_SHOW', note: 'GHL stage: TCC Purchased (pre-call rule)' },
  'contacted':                     { stage: 'NO_SHOW', note: 'GHL stage: Contacted (pre-call rule)' },
  'call back':                     { stage: 'NO_SHOW', note: 'GHL stage: Call Back (pre-call rule)' },
  'new lead':                      { stage: 'NO_SHOW', note: 'GHL stage: New Lead (pre-call rule)' },
  'no answer 1':                   { stage: 'NO_SHOW', note: 'GHL stage: No Answer 1 (pre-call rule)' },
  'no answer 2':                   { stage: 'NO_SHOW', note: 'GHL stage: No Answer 2 (pre-call rule)' },
  'no answer 3 | weekly outreach': { stage: 'NO_SHOW', note: 'GHL stage: No Answer 3 (pre-call rule)' },

  // Setter moved back to Call Booked — leave row at BOOKED (reschedule case)
  'call booked':                   { stage: 'BOOKED',  note: null },
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
      service: 'SWH GHL Webhook Receiver',
      target_table: 'calls',
      stage_map_size: Object.keys(STAGE_MAP).length,
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const payload = req.body || {};
  console.log('=== GHL WEBHOOK RECEIVED ===');
  console.log('Full payload:', JSON.stringify(payload, null, 2));

  try {
    const email = deepFind(payload, ['email', 'contact_email', 'contactEmail']).toLowerCase().trim();
    const contactId = deepFind(payload, ['contact_id', 'contactId', 'contactID']);
    const opportunityId = deepFind(payload, ['opportunity_id', 'opportunityId', 'opp_id', 'oppId']);
    const stageRaw = deepFind(payload, [
      'pipeline_stage', 'pipelineStage', 'stage', 'stage_name', 'stageName',
      'opportunity_stage', 'opportunityStage', 'new_stage', 'newStage',
      'current_stage', 'currentStage'
    ]);
    const stageKey = stageRaw.trim().toLowerCase();
    const pipelineName = deepFind(payload, ['pipeline_name', 'pipelineName', 'pipeline']);

    console.log('Extracted:', { email, contactId, opportunityId, stageRaw, pipelineName });

    if (!email) {
      return res.status(200).json({
        ok: true,
        action: 'skipped_no_email',
        received_keys: Object.keys(payload),
      });
    }

    if (!stageRaw) {
      return res.status(200).json({
        ok: true,
        action: 'skipped_no_stage',
        email,
      });
    }

    const mapping = STAGE_MAP[stageKey];
    if (!mapping) {
      console.log('Unknown stage, ignoring:', stageRaw);
      return res.status(200).json({
        ok: true,
        action: 'unknown_stage',
        email,
        stage: stageRaw,
      });
    }

    // ---- Find matching call ----
    // Match by lowercase email; pick the most recent call whose scheduled_at
    // is in the past (or the only call if just one exists; or the most recent
    // overall if no past call yet).
    const lookupUrl =
      `${SUPABASE_URL}/rest/v1/calls` +
      `?invitee_email=eq.${encodeURIComponent(email)}` +
      `&order=scheduled_at.desc` +
      `&limit=20`;

    const lookupRes = await fetch(lookupUrl, {
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

    if (!matches || matches.length === 0) {
      console.log('No calls match for:', email);
      return res.status(200).json({
        ok: true,
        action: 'no_match',
        email,
        stage: stageRaw,
      });
    }

    // Pick target: most recent past call, else most recent overall
    const now = new Date();
    const pastCalls = matches.filter(m => new Date(m.scheduled_at) <= now);
    const targetRow = (pastCalls[0]) || matches[0];

    // ---- Build the patch ----
    const patch = {
      stage: mapping.stage,
      ghl_stage_raw: stageRaw,
      ghl_stage_updated_at: new Date().toISOString(),
    };
    if (opportunityId) patch.ghl_opportunity_id = opportunityId;
    if (mapping.note)  patch.manual_outcome_note = mapping.note;

    // ---- Apply ----
    const updateRes = await fetch(
      `${SUPABASE_URL}/rest/v1/calls?id=eq.${targetRow.id}`,
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

    console.log('Updated calls row:', targetRow.id, '→', mapping.stage);
    return res.status(200).json({
      ok: true,
      action: 'updated',
      row_id: targetRow.id,
      email,
      scheduled_at: targetRow.scheduled_at,
      from_ghl_stage: stageRaw,
      to_stage: mapping.stage,
    });

  } catch (e) {
    console.error('GHL webhook handler error:', e);
    return res.status(200).json({ ok: true, action: 'error_caught', message: e.message });
  }
}
