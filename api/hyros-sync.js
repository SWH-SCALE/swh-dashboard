// /api/hyros-sync.js
// Inspect 401 response headers — Hyros should tell us the auth scheme via WWW-Authenticate
const HYROS_BASE = 'https://api.hyros.com/v1/api/v1.0';
const HYROS_API_KEY = process.env.HYROS_API_KEY;

export default async function handler(req, res) {
  if (!HYROS_API_KEY) {
    return res.status(500).json({ error: 'HYROS_API_KEY not set' });
  }

  const url = `${HYROS_BASE}/leads?pageSize=1`;

  // Hit with no auth at all — server should tell us what it wants
  const noAuth = await fetch(url);
  const noAuthHeaders = {};
  noAuth.headers.forEach((v, k) => { noAuthHeaders[k] = v; });

  // Hit with API-Key — capture response headers + body
  const withAuth = await fetch(url, { headers: { 'API-Key': HYROS_API_KEY } });
  const withAuthHeaders = {};
  withAuth.headers.forEach((v, k) => { withAuthHeaders[k] = v; });
  const withAuthBody = await withAuth.text();

  return res.status(200).json({
    base: HYROS_BASE,
    key_prefix: HYROS_API_KEY.slice(0, 8),
    no_auth: {
      status: noAuth.status,
      headers: noAuthHeaders,
    },
    with_api_key_header: {
      status: withAuth.status,
      headers: withAuthHeaders,
      body: withAuthBody.slice(0, 500),
    },
  });
}
