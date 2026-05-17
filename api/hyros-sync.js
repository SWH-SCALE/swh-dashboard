// /api/hyros-sync.js
// level uses platform prefix: facebook_ad / facebook_adset / facebook_campaign
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

  // confirmed valid: attributionModel=last_click, fields=revenue,sales,cost,profit
  // testing the platform-prefixed level values from the Hyros changelog
  const levels = [
    'facebook_ad', 'facebook_adset', 'facebook_campaign',
    'facebook_account', 'facebook', 'facebook_ad_account',
  ];

  for (const lvl of levels) {
    // use accountId for account-level, adId for everything else
    const idForLevel = lvl.includes('account') ? accountId : adId;
    const qs = new URLSearchParams({
      startDate: sd, endDate: ed,
      attributionModel: 'last_click',
      level: lvl,
      fields: 'revenue,sales,cost,profit',
      ids: idForLevel || 'none',
    }).toString();
    try {
      const r = await fetch(`${HYROS_BASE}/attribution?${qs}`, { headers: H });
      results[lvl] = {
        idUsed: idForLevel,
        status: r.status,
        body: (await r.text()).slice(0, 800),
      };
    } catch (e) {
      results[lvl] = { error: e.message };
    }
  }

  return res.status(200).json({ dateRange: { sd, ed }, adId, accountId, results });
}
