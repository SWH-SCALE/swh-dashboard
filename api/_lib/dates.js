// Date helpers. All reminder maths uses calendar dates (YYYY-MM-DD) in the
// business timezone, so "3 days before" means 3 calendar days in Dubai
// (or whatever BUSINESS_TIMEZONE is), not 72 hours.

export function todayIn(timezone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.slice(0, 10));
}

function toUtcMs(dateStr) {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

// b - a in whole days
export function daysBetween(a, b) {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / 86400000);
}

export function addDays(dateStr, n) {
  const d = new Date(toUtcMs(dateStr) + n * 86400000);
  return d.toISOString().slice(0, 10);
}

export function formatLongDate(dateStr) {
  const d = new Date(toUtcMs(dateStr));
  return d.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

export function formatShortDate(dateStr) {
  const d = new Date(toUtcMs(dateStr));
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}
