// /api/meta-sync.js
// Pulls daily ad spend from Meta Marketing API, converts GBP->USD,
// and upserts one row per day into the Supabase `meta_spend` table.
//
// Runs automatically via Vercel cron (see vercel.json) and also on manual GET.

const META_TOKEN   = process.env.META_ACCESS_TOKEN;
const META_ACCOUNT = process.env.META_AD_ACCOUNT_ID;
const SUPABASE_URL = 'https://qstlyvauppjkdiwpgtql.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

// GBP -> USD conversion rate. Update this value occasionally if the rate drifts.
const GBP_TO_USD = 1.27;

// How many days back to sync each run (covers late-reported spend adjustments).
const DAYS_BACK = 90;

export default async function handler(req, res) {
  // --- guard: required config ---
  if (!META_TOKEN)   return res.status(500).json({ ok: false, error: 'META_ACCESS_TOKEN not set' });
  if (!META_ACCOUNT) return res.status(500).json({ ok: false, error: 'META_AD_ACCOUNT_ID not set' });
  if (!SUPABASE_KEY) return res.status(500).json({ ok: false, error: 'SUPABASE_ANON_KEY not set' });

  try {
    // --- 1. pull daily spend from Meta ---
    const since = new Date();
    since.setDate(since.getDate() - DAYS_BACK);
    const until = new Date();
    const fmt = d => d.toISOString().split('T')[0];

    const metaUrl = `https://graph.facebook.com/v21.0/${META_ACCOUNT}/insights`
      + `?fields=spend,impressions,clicks`
      + `&time_increment=1`
      + `&time_range=${encodeURIComponent(JSON.stringify({ since: fmt(since), until: fmt(until) }))}`
      + `&limit=500`
      + `&access_token=${META_TOKEN}`;

    const metaRes = await fetch(metaUrl);
    const metaJson = await metaRes.json();

    if (metaJson.error) {
      return res.status(502).json({ ok: false, stage: 'meta', error: metaJson.error });
    }

    const rows = metaJson.data || [];
    if (rows.length === 0) {
      return res.status(200).json({ ok: true, message: 'No spend rows returned from Meta', daysWritten: 0 });
    }

    // --- 2. build upsert payload, converting GBP -> USD ---
    const payload = rows.map(r => ({
      spend_date:  r.date_start,
      spend:       +( (parseFloat(r.spend) || 0) * GBP_TO_USD ).toFixed(2),
      impressions: parseInt(r.impressions) || 0,
      clicks:      parseInt(r.clicks) || 0,
      currency:    'USD',
      synced_at:   new Date().toISOString(),
    }));

    // --- 3. upsert into Supabase (on_conflict=spend_date overwrites same-day rows) ---
    const upsertRes = await fetch(
      `${SUPABASE_URL}/rest/v1/meta_spend?on_conflict=spend_date`,
      {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(payload),
      }
    );

    if (!upsertRes.ok) {
      const errText = await upsertRes.text();
      return res.status(502).json({ ok: false, stage: 'supabase', status: upsertRes.status, error: errText });
    }

    // --- 4. summary ---
    const totalUsd = payload.reduce((s, p) => s + p.spend, 0);
    return res.status(200).json({
      ok: true,
      daysWritten: payload.length,
      dateRange: { from: payload[0].spend_date, to: payload[payload.length - 1].spend_date },
      totalSpendUsd: +totalUsd.toFixed(2),
      rate: GBP_TO_USD,
    });

  } catch (e) {
    return res.status(500).json({ ok: false, stage: 'exception', error: e.message });
  }
}
