// /api/hyros-sync.js  — TEMPORARY: Meta spend test probe
const META_TOKEN = process.env.META_ACCESS_TOKEN;
const META_ACCOUNT = process.env.META_AD_ACCOUNT_ID;

export default async function handler(req, res) {
  if (!META_TOKEN)   return res.status(500).json({ error: 'META_ACCESS_TOKEN not set' });
  if (!META_ACCOUNT) return res.status(500).json({ error: 'META_AD_ACCOUNT_ID not set' });

  const results = {};

  // 1. Account-level total spend, last 30 days
  try {
    const url = `https://graph.facebook.com/v21.0/${META_ACCOUNT}/insights`
      + `?fields=spend,impressions,clicks`
      + `&date_preset=last_30d`
      + `&access_token=${META_TOKEN}`;
    const r = await fetch(url);
    results.accountTotal = { status: r.status, body: await r.json() };
  } catch (e) {
    results.accountTotal = { error: e.message };
  }

  // 2. Daily spend breakdown, last 7 days
  try {
    const url = `https://graph.facebook.com/v21.0/${META_ACCOUNT}/insights`
      + `?fields=spend`
      + `&date_preset=last_7d`
      + `&time_increment=1`
      + `&access_token=${META_TOKEN}`;
    const r = await fetch(url);
    results.dailyBreakdown = { status: r.status, body: await r.json() };
  } catch (e) {
    results.dailyBreakdown = { error: e.message };
  }

  // 3. Confirm the account is reachable + its name
  try {
    const url = `https://graph.facebook.com/v21.0/${META_ACCOUNT}`
      + `?fields=name,account_status,currency`
      + `&access_token=${META_TOKEN}`;
    const r = await fetch(url);
    results.accountInfo = { status: r.status, body: await r.json() };
  } catch (e) {
    results.accountInfo = { error: e.message };
  }

  return res.status(200).json({ account: META_ACCOUNT, results });
}
