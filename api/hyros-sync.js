// /api/hyros-sync.js
// Crack the /attribution required fields — try common value vocabularies
const HYROS_BASE = 'https://api.hyros.com/v1/api/v1.0';
const HYROS_API_KEY = process.env.HYROS_API_KEY;

export default async function handler(req, res) {
  if (!HYROS_API_KEY) {
    return res.status(500).json({ error: 'HYROS_API_KEY not set' });
  }
  const H = { 'API-Key': HYROS_API_KEY };
  const results = {};

  // Safe past date range — 30 days ending a week ago (avoids "future date" error)
  const end = new Date(); end.setDate(end.getDate() - 7);
  const start = new Date(); start.setDate(start.getDate() - 37);
  const fmt = d => d.toISOString().split('T')[0];
  const sd = fmt(start), ed = fmt(end);

  // First: get a real adSourceId from /sources to use as `ids`
  let adId = null, accountId = null;
  try {
    const sr = await fetch(`${HYROS_BASE}/sources?pageSize=5`, { headers: H });
    const sj = await sr.json();
    const first = (sj.result || []).find(s => s.adSource && s.adSource.adSourceId);
    if (first) {
      adId = first.adSource.adSourceId;
      accountId = first.adSource.adAccountId;
    }
    results['_sources'] = { adId, accountId, count: (sj.result||[]).length };
  } catch (e) {
    results['_sources'] = { error: e.message };
  }

  // Try /attribution with different combinations of the 4 required fields
  const attempts = [
    { attributionModel: 'last_click', level: 'campaign', fields: 'revenue,sales,cost,profit', ids: adId },
    { attributionModel: 'LAST_CLICK', level: 'CAMPAIGN', fields: 'revenue,sales,cost,profit', ids: adId },
    { attributionModel: 'last_click', level: 'account', fields: 'revenue,sales,cost,profit,roas', ids: accountId },
    { attributionModel: 'lastClick', level: 'ad', fields: 'totalRevenue,totalSales,cost,profit', ids: adId },
    { attributionModel: 'last_click', level: 'campaign', fields: 'all', ids: adId },
  ];

  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    const qs = new URLSearchParams({
      startDate: sd, endDate: ed,
      attributionModel: a.attributionModel,
      level: a.level,
      fields: a.fields,
      ids: a.ids || 'none',
    }).toString();
    try {
      const r = await fetch(`${HYROS_BASE}/attribution?${qs}`, { headers: H });
      results['attempt_' + (i+1)] = {
        params: a,
        status: r.status,
        body: (await r.text()).slice(0, 700),
      };
    } catch (e) {
      results['attempt_' + (i+1)] = { error: e.message };
    }
  }

  return res.status(200).json({ dateRange: { sd, ed }, results });
}
