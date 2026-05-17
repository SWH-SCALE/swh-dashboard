// /api/hyros-sync.js
// Probe endpoints for sales, spend, and other data
const HYROS_BASE = 'https://api.hyros.com/v1/api/v1.0';
const HYROS_API_KEY = process.env.HYROS_API_KEY;

export default async function handler(req, res) {
  if (!HYROS_API_KEY) {
    return res.status(500).json({ error: 'HYROS_API_KEY not set' });
  }

  // Probe a wide set of likely endpoints
  const endpoints = [
    'sales',
    'orders',
    'spend',
    'ad-spend',
    'adspend',
    'attribution',
    'attribution/sales',
    'reports',
    'reports/sales',
    'reports/spend',
    'reports/profit',
    'analytics',
    'campaigns',
    'sources',
    'traffic-sources',
    'leads/info',
    'calls',
  ];

  const results = {};
  for (const ep of endpoints) {
    const url = `${HYROS_BASE}/${ep}?pageSize=1`;
    try {
      const r = await fetch(url, { headers: { 'API-Key': HYROS_API_KEY } });
      const text = await r.text();
      results[ep] = {
        status: r.status,
        // First 600 chars so we can see field names if it returned JSON
        body: text.slice(0, 600),
      };
    } catch (e) {
      results[ep] = { error: e.message };
    }
  }

  // Also get a full leads sample so we can see field names there
  try {
    const r = await fetch(`${HYROS_BASE}/leads?pageSize=3`, {
      headers: { 'API-Key': HYROS_API_KEY }
    });
    results['leads_sample'] = {
      status: r.status,
      body: (await r.text()).slice(0, 1500),
    };
  } catch (e) {
    results['leads_sample'] = { error: e.message };
  }

  return res.status(200).json({ base: HYROS_BASE, results });
}
