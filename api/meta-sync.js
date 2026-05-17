// /api/meta-sync.js
// Pulls daily ad spend from the Meta Marketing API, converts GBP->USD,
// and upserts one row per day into the Supabase `meta_spend` table.
//
// Runs automatically every day via Vercel cron (see vercel.json),
// and also on a manual GET to /api/meta-sync.
//
// Each run pulls the FULL history from SYNC_START_DATE to today, so the
// data self-heals: any late spend adjustments from Meta get corrected.

const META_TOKEN   = process.env.META_ACCESS_TOKEN;
const META_ACCOUNT = process.env.META_AD_ACCOUNT_ID;
const SUPABASE_URL = 'https://qstlyvauppjkdiwpgtql.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

// ---- CONFIG ----------------------------------------------------------------
// First date to pull spend from. The sync always covers this date -> today.
const SYNC_START_DATE = '2025-10-30';

// GBP -> USD conversion rate. Meta reports this account in GBP; the dashboard
// shows USD. Update this number occasionally if the rate drifts noticeably.
const GBP_TO_USD = 1.27;
// ----------------------------------------------------------------------------

export default async function handler(req, res) {
  // --- guard: required config ---
  if (!META_TOKEN)   return res.status(500).json({ ok: false, error: 'META_ACCESS_TOKEN not set' });
  if (!META_ACCOUNT) return res.status(500).json({ ok: false, error: 'META_AD_ACCOUNT_ID not set' });
  if (!SUPABASE_KEY) return res.status(500).json({ ok: false, error: 'SUPABASE_ANON_KEY not set' });

  try {
    const today = new Date().toISOString().split('T')[0];

    // --- 1. pull daily spend from Meta, following pagination ---
    const timeRange = encodeURIComponent(JSON.stringify({ since: SYNC_START_DATE, until: today }));
    let url = `https://graph.facebook.com/v21.0/${META_ACCOUNT}/insights`
      + `?fields=spend,impressions,clicks`
      + `&time_increment=1`
      + `&time_range=${timeRange}`
      + `&limit=500`
      + `&access_token=${META_TOKEN}`;

    const rows = [];
    let pages = 0;

    while (url && pages < 20) {
      const metaRes = await fetch(url);
      const metaJson = await metaRes.json();

      if (metaJson.error) {
        return res.status(502).json({ ok: false, stage: 'meta', page: pages, error: metaJson.error });
      }

      (metaJson.data || []).forEach(r => rows.push(r));

      // follow the "next" cursor if Meta split the result across pages
      url = (metaJson.paging && metaJson.paging.next) ? metaJson.paging.next : null;
      pages++;
    }

    if (rows.length === 0) {
      return res.status(200).json({
        ok: true,
        message: 'No spend rows returned from Meta for this date range',
        daysWritten: 0,
        dateRange: { from: SYNC_START_DATE, to: today },
      });
    }

    // --- 2. build upsert payload, converting GBP -> USD ---
    const payload = rows.map(r => ({
      spend_date:  r.date_start,
      spend:       +(((parseFloat(r.spend) || 0) * GBP_TO_USD).toFixed(2)),
      impressions: parseInt(r.impressions) || 0,
      clicks:      parseInt(r.clicks) || 0,
      currency:    'USD',
      synced_at:   new Date().toISOString(),
    }));

    // sort by date so the summary range reads correctly
    payload.sort((a, b) => a.spend_date.localeCompare(b.spend_date));

    // --- 3. upsert into Supabase ---
    // on_conflict=spend_date + merge-duplicates => re-running overwrites the
    // same day instead of inserting a duplicate. Safe to run any number of times.
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
      return res.status(502).json({
        ok: false,
        stage: 'supabase',
        status: upsertRes.status,
        error: errText,
      });
    }

    // --- 4. summary ---
    const totalUsd = payload.reduce((s, p) => s + p.spend, 0);
    return res.status(200).json({
      ok: true,
      daysWritten: payload.length,
      dateRange: { from: payload[0].spend_date, to: payload[payload.length - 1].spend_date },
      totalSpendUsd: +totalUsd.toFixed(2),
      rate: GBP_TO_USD,
      metaPagesFetched: pages,
    });

  } catch (e) {
    return res.status(500).json({ ok: false, stage: 'exception', error: e.message });
  }
}
