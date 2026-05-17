// /api/hyros-sync.js
// Final: brute-force the `level` value — everything else is confirmed valid
const HYROS_BASE = 'https://api.hyros.com/v1/api/v1.0';
const HYROS_API_KEY = process.env.HYROS_API_KEY;

export default async function handler(req, res) {
  if (!HYROS_API_KEY) {
    return res.status(500).json({ error: 'HYROS_API_KEY not set' });
  }
  const H = { 'API-Key': HYROS_API_KEY };
  const results = {};

  const end = new Date(); end.setDate(end.getDate() - 7);
  const start = new Date(); start.setDate(start.getDate() - 37);
  const fmt = d => d.toISOString().split('T')[0];
  const sd = fmt(start), ed = fmt(end);

  // Get a real adSourceId + adAccountId from /sources
  let adId = null, accountId = null;
  try {
    const sr = await fetch(`${HYROS_BASE}/sources?pageSize=5`, { headers: H });
    const sj = await sr.json();
    const first = (sj.result || []).find(s => s.adSource && s.adSource.adSourceId);
    if (first) { adId = first.adSource.adSourceId; accountId = first.adSource.adAccountId; }
  } catch (e) {}

  // confirmed-good: attributionModel=last_click, fields=revenue,sales,cost,profit
  // unknown: level. Try every plausible value.
  const levels = [
    'ad', 'AD', 'ad_source', 'adSource', 'adset', 'ad_set', 'adSet',
    'campaign_group', 'source', 'sourceLink', 'source_link',
    'lead', 'sale', 'click', 'day', 'daily', 'date', 'total', 'summary',
    'account_level', 'ad_account', 'adAccount'
  ];

  for (const lvl of levels) {
    const qs = new URLSearchParams({
      startDate: sd, endDate: ed,
      attributionModel: 'last_click',
      level: lvl,
      fields: 'revenue,sales,cost,profit',
      ids: adId || 'none',
    }).toString();
    try {
      const r = await fetch(`${HYROS_BASE}/attribution?${qs}`, { headers: H });
      const body = (await r.text()).slice(0, 500);
      // Only record results that AREN'T "Invalid level" — those are the interesting ones
      const isInvalidLevel = body.includes('Invalid level');
      results[lvl] = {
        status: r.status,
        invalidLevel: isInvalidLevel,
        body: body,
      };
    } catch (e) {
      results[lvl] = { error: e.message };
    }
  }

  return res.status(200).json({ dateRange: { sd, ed }, adId, accountId, results });
}
