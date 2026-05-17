// /api/hyros-sync.js
// Probe /attribution with date params + full sales field dump
const HYROS_BASE = 'https://api.hyros.com/v1/api/v1.0';
const HYROS_API_KEY = process.env.HYROS_API_KEY;

export default async function handler(req, res) {
  if (!HYROS_API_KEY) {
    return res.status(500).json({ error: 'HYROS_API_KEY not set' });
  }

  const H = { 'API-Key': HYROS_API_KEY };
  const results = {};

  // Date range: last 30 days
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);
  const fmt = d => d.toISOString().split('T')[0];
  const sd = fmt(start), ed = fmt(end);

  // Try /attribution with various date param name conventions
  const attrVariants = [
    `attribution?startDate=${sd}&endDate=${ed}`,
    `attribution?startDate=${sd}T00:00:00Z&endDate=${ed}T23:59:59Z`,
    `attribution?start_date=${sd}&end_date=${ed}`,
    `attribution?fromDate=${sd}&toDate=${ed}`,
    `attribution?from=${sd}&to=${ed}`,
  ];
  for (let i = 0; i < attrVariants.length; i++) {
    try {
      const r = await fetch(`${HYROS_BASE}/${attrVariants[i]}`, { headers: H });
      results['attribution_v' + (i+1)] = {
        query: attrVariants[i],
        status: r.status,
        body: (await r.text()).slice(0, 800),
      };
    } catch (e) {
      results['attribution_v' + (i+1)] = { error: e.message };
    }
  }

  // Full sales record — every field, so we can see if revenue/amount is in there
  try {
    const r = await fetch(`${HYROS_BASE}/sales?pageSize=2`, { headers: H });
    results['sales_full'] = { status: r.status, body: (await r.text()).slice(0, 2000) };
  } catch (e) {
    results['sales_full'] = { error: e.message };
  }

  // Single sale by detail — sometimes detail endpoint has more fields
  try {
    const r = await fetch(`${HYROS_BASE}/sales?pageSize=1&fields=price,amount,revenue,total`, { headers: H });
    results['sales_fields'] = { status: r.status, body: (await r.text()).slice(0, 1000) };
  } catch (e) {
    results['sales_fields'] = { error: e.message };
  }

  return res.status(200).json({ dateRange: { sd, ed }, results });
}
