// /api/hyros-sync.js
// DECISIVE TEST: query /attribution across ALL ad sources for a known-active window
const HYROS_BASE = 'https://api.hyros.com/v1/api/v1.0';
const HYROS_API_KEY = process.env.HYROS_API_KEY;

export default async function handler(req, res) {
  if (!HYROS_API_KEY) {
    return res.status(500).json({ error: 'HYROS_API_KEY not set' });
  }
  const H = { 'API-Key': HYROS_API_KEY };

  // Known-active window from the Hyros dashboard screenshot (showed £2,929 cost)
  const sd = '2026-05-08';
  const ed = '2026-05-14';

  // 1. Pull ALL ad sources (follow pagination)
  const adSourceIds = new Set();
  let pageId = null;
  let pages = 0;
  try {
    do {
      const url = `${HYROS_BASE}/sources?pageSize=50` + (pageId ? `&pageId=${pageId}` : '');
      const r = await fetch(url, { headers: H });
      const j = await r.json();
      (j.result || []).forEach(s => {
        if (s.adSource && s.adSource.adSourceId) adSourceIds.add(s.adSource.adSourceId);
      });
      pageId = j.nextPageId || null;
      pages++;
    } while (pageId && pages < 20);
  } catch (e) {
    return res.status(200).json({ stage: 'sources_failed', error: e.message });
  }

  const ids = [...adSourceIds];

  // 2. Query /attribution for each, at campaign level, sum the totals
  let totals = { sales: 0, revenue: 0, profit: 0, cost: 0 };
  const perSource = [];
  let nonZeroCount = 0;

  for (const id of ids.slice(0, 60)) { // cap at 60 to stay within function timeout
    const qs = new URLSearchParams({
      startDate: sd, endDate: ed,
      attributionModel: 'last_click',
      level: 'facebook_campaign',
      fields: 'revenue,sales,cost,profit',
      ids: id,
    }).toString();
    try {
      const r = await fetch(`${HYROS_BASE}/attribution?${qs}`, { headers: H });
      const j = await r.json();
      const rows = j.result || [];
      for (const row of rows) {
        const rev  = parseFloat(row.revenue) || 0;
        const cost = parseFloat(row.cost)    || 0;
        const prof = parseFloat(row.profit)  || 0;
        const sale = parseInt(row.sales)     || 0;
        totals.revenue += rev;
        totals.cost    += cost;
        totals.profit  += prof;
        totals.sales   += sale;
        if (rev || cost || prof || sale) {
          nonZeroCount++;
          perSource.push({ id, rev, cost, prof, sale });
        }
      }
    } catch (e) {
      // skip failed source
    }
  }

  return res.status(200).json({
    window: { sd, ed },
    totalAdSources: ids.length,
    queried: Math.min(ids.length, 60),
    nonZeroSources: nonZeroCount,
    totals,
    sampleNonZero: perSource.slice(0, 10),
  });
}
