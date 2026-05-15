// /api/hyros-sync.js
// Auth header probe — tries multiple header formats on /leads
const HYROS_BASE = 'https://api.hyros.com/v1/api/v1.0';
const HYROS_API_KEY = process.env.HYROS_API_KEY;

export default async function handler(req, res) {
  if (!HYROS_API_KEY) {
    return res.status(500).json({ error: 'HYROS_API_KEY not set' });
  }

  const url = `${HYROS_BASE}/leads?pageSize=1`;

  const authVariants = [
    { name: 'API-Key',              headers: { 'API-Key': HYROS_API_KEY } },
    { name: 'Api-Key',              headers: { 'Api-Key': HYROS_API_KEY } },
    { name: 'X-API-Key',            headers: { 'X-API-Key': HYROS_API_KEY } },
    { name: 'Authorization-Bearer', headers: { 'Authorization': `Bearer ${HYROS_API_KEY}` } },
    { name: 'Authorization-raw',    headers: { 'Authorization': HYROS_API_KEY } },
    { name: 'api_key-query',        headers: {}, qs: `&api_key=${encodeURIComponent(HYROS_API_KEY)}` },
  ];

  const results = {};
  for (const v of authVariants) {
    try {
      const fullUrl = v.qs ? url + v.qs : url;
      const r = await fetch(fullUrl, { headers: v.headers });
      const text = await r.text();
      results[v.name] = { status: r.status, body: text.slice(0, 300) };
    } catch (e) {
      results[v.name] = { error: e.message };
    }
  }

  return res.status(200).json({
    base: HYROS_BASE,
    key_length: HYROS_API_KEY.length,
    key_prefix: HYROS_API_KEY.slice(0, 8),
    results
  });
}
