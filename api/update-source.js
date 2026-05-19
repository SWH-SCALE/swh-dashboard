// /api/update-source.js
// Updates the `source` column of a single retainer_payments row.
// Called by the ads/organic toggle on the Retainers tab.

const SUPABASE_URL = 'https://qstlyvauppjkdiwpgtql.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  if (!SUPABASE_KEY) {
    return res.status(500).json({ ok: false, error: 'SUPABASE_ANON_KEY not set' });
  }

  const { id, source } = req.body || {};

  // validate
  if (!id) {
    return res.status(400).json({ ok: false, error: 'Missing payment id' });
  }
  if (source !== 'ads' && source !== 'organic') {
    return res.status(400).json({ ok: false, error: "source must be 'ads' or 'organic'" });
  }

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/retainer_payments?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ source }),
      }
    );

    if (!r.ok) {
      const errText = await r.text();
      return res.status(502).json({ ok: false, stage: 'supabase', error: errText });
    }

    return res.status(200).json({ ok: true, id, source });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
