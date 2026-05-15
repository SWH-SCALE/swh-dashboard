// /api/hyros-sync.js
// Minimal probe — hits Hyros endpoints to verify auth + base URL
const HYROS_BASE = 'https://api.hyros.com/v1/api/v1.0';
const HYROS_API_KEY = process.env.HYROS_API_KEY;

export default async function handler(req, res) {
  if (!HYROS_API_KEY) {
    return res.status(500).json({ error: 'HYROS_API_KEY not set' });
  }

  const tests = [
    { name: 'leads',         url: `${HYROS_BASE}/leads?pageSize=1` },
    { name: 'subscriptions', url: `${HYROS_BASE}/subscriptions?pageSize=1` },
    { name: 'sales',         url: `${HYROS_BASE}/sales?pageSize=1` },
    { name: 'calls',         url: `${HYROS_BASE}/calls?pageSize=1` },
  ];

  const results = {};
  for (const t of tests) {
    try {
      const r = await fetch(t.url, {
        headers: { 'API-Key': HYROS_API_KEY }
      });
      const text = await r.text();
      results[t.name] = {
        status: r.status,
        body: text.slice(0, 400)
      };
    } catch (e) {
      results[t.name] = { error: e.message };
    }
  }

  return res.status(200).json({ base: HYROS_BASE, results });
}
