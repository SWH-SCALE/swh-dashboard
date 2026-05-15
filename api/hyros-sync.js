// /api/hyros-sync.js
// Pulls attribution + spend + sales data from Hyros API.
// Run by hitting this URL directly (GET). Returns JSON.
//
// FIRST GOAL: confirm the API key works and we can read SOMETHING from Hyros.
// Once that's verified, we expand to pull specific metrics and cache them in Supabase.

const HYROS_BASE = 'https://api.hyros.com/v1';
const HYROS_API_KEY = process.env.HYROS_API_KEY;

// Helper: call Hyros with the API key
async function hyrosFetch(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${HYROS_BASE}${path}${qs ? '?' + qs : ''}`;
  const res = await fetch(url, {
    headers: {
      // Hyros uses API-Key header (per their docs and common integrations)
      'API-Key': HYROS_API_KEY,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

export default async function handler(req, res) {
  if (!HYROS_API_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'HYROS_API_KEY env variable is not set in Vercel',
    });
  }

  // Step 1: try a few common Hyros endpoints to see which work with this key
  // Different Hyros plans expose different endpoints, so we probe a few
  const probes = [
    { name: 'leads',        path: '/leads',        params: { limit: 1 } },
    { name: 'sales',        path: '/sales',        params: { limit: 1 } },
    { name: 'attribution',  path: '/attribution',  params: {} },
    { name: 'reports',      path: '/reports',      params: {} },
    { name: 'orders',       path: '/orders',       params: { limit: 1 } },
    { name: 'calls',        path: '/calls',        params: { limit: 1 } },
  ];

  const results = {};
  for (const probe of probes) {
    try {
      const result = await hyrosFetch(probe.path, probe.params);
      results[probe.name] = {
        endpoint: probe.path,
        status: result.status,
        ok: result.ok,
        sample: result.ok
          ? (typeof result.data === 'object' ? JSON.stringify(result.data).slice(0, 400) : String(result.data).slice(0, 400))
          : (result.data?.message || result.data?.error || JSON.stringify(result.data).slice(0, 200)),
      };
    } catch (e) {
      results[probe.name] = { endpoint: probe.path, error: e.message };
    }
  }

  // Also try Bearer auth in case API-Key doesn't work
  const bearerProbe = await fetch(`${HYROS_BASE}/leads?limit=1`, {
    headers: {
      'Authorization': `Bearer ${HYROS_API_KEY}`,
      'Content-Type': 'application/json',
    },
  }).then(r => r.text()).then(t => {
    try { return JSON.parse(t); } catch { return { raw: t.slice(0,300) }; }
  }).catch(e => ({ error: e.message }));
  results.bearer_auth_test = bearerProbe;

  return res.status(200).json({
    ok: true,
    message: 'Hyros API probe results',
    note: 'Look for the endpoint that returned a 200 status — that one is reachable with your key.',
    base_url: HYROS_BASE,
    auth_method_tried: 'API-Key header (and Bearer as fallback)',
    results,
  });
}
