// /api/hyros-sync.js
// Diagnostic probe v2 — tries the correct /api/v1.0/ base URL plus common endpoints

const HYROS_BASE = 'https://api.hyros.com/api/v1.0';
const HYROS_API_KEY = process.env.HYROS_API_KEY;

async function hyrosFetch(path, params = {}, authMode = 'api-key') {
  const qs = new URLSearchParams(params).toString();
  const url = `${HYROS_BASE}${path}${qs ? '?' + qs : ''}`;
  const headers = { 'Content-Type': 'application/json' };
  if (authMode === 'api-key') headers['API-Key'] = HYROS_API_KEY;
  else if (authMode === 'bearer') headers['Authorization'] = `Bearer ${HYROS_API_KEY}`;
  else if (authMode === 'x-api-key') headers['X-API-Key'] = HYROS_API_KEY;

  const res = await fetch(url, { headers });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 300) }; }
  return { ok: res.ok, status: res.status, data, url };
}

export default async function handler(req, res) {
  if (!HYROS_API_KEY) {
    return res.status(500).json({ ok: false, error: 'HYROS_API_KEY env variable is not set' });
  }

  // Probe common endpoint names with the correct base URL
  const probes = [
    { name: 'leads',                path: '/leads',                params: { pageSize: 1 } },
    { name: 'subscriptions',        path: '/subscriptions',        params: { pageSize: 1 } },
    { name: 'orders',               path: '/orders',               params: { pageSize: 1 } },
    { name: 'attribution_sources',  path: '/attribution/sources',  params: {} },
    { name: 'attribution',          path: '/attribution',          params: {} },
    { name: 'sources',              path: '/sources',              params: {} },
    { name: 'sales',                path: '/sales',                params: { pageSize: 1 } },
    { name: 'reports',              path: '/reports',              params: {} },
    { name: 'calls',                path: '/calls',                params: { pageSize: 1 } },
    { name: 'tags',                 path: '/tags',                 params: {} },
    { name: 'products',             path: '/products',             params: {} },
  ];

  const results = {};

  // Try API-Key header first (the common Hyros pattern)
  for (const probe of probes) {
    try {
      const result = await hyrosFetch(probe.path, probe.params, 'api-key');
      results[probe.name] = {
        url: result.url,
        status: result.status,
        ok: result.ok,
        sample: typeof result.data === 'object'
          ? JSON.stringify(result.data).slice(0, 300)
          : String(result.data).slice(0, 300),
      };
    } catch (e) {
      results[probe.name] = { error: e.message };
    }
  }

  // If everything failed, try Bearer auth on /leads as a sanity check
  const anyOk = Object.values(results).some(r => r.ok);
  if (!anyOk) {
    try {
      const bearer = await hyrosFetch('/leads', { pageSize: 1 }, 'bearer');
      results['_bearer_test_leads'] = {
        url: bearer.url,
        status: bearer.status,
        sample: typeof bearer.data === 'object'
          ? JSON.stringify(bearer.data).slice(0, 300)
          : String(bearer.data).slice(0, 300),
      };
    } catch (e) {
      results['_bearer_test_leads'] = { error: e.message };
    }
  }

  return res.status(200).json({
    ok: true,
    message: 'Hyros API probe v2',
    base_url: HYROS_BASE,
    auth_method: 'API-Key header (Bearer fallback if all fail)',
    any_endpoint_worked: anyOk,
    results,
  });
}
