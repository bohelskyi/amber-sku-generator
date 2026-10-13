const kyivClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', hourCycle: 'h23',
});

function normalizeStrictRateDate(value) {
  const text = String(value || '').trim();
  const nbu = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  const iso = nbu ? `${nbu[3]}-${nbu[2]}-${nbu[1]}` : text;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const date = new Date(`${iso}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

// A civil-day key, not an elapsed 24-hour interval. Kyiv's DST transitions do
// not repeat or skip 04:00. Before 04:00 the previous scheduled period is valid.
function getRatePeriod(date) {
  const parts = Object.fromEntries(kyivClock.formatToParts(date).map(part => [part.type, part.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  if (Number(parts.hour) >= 4) return day;
  const previous = new Date(`${day}T00:00:00.000Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}

module.exports = { getRatePeriod, normalizeStrictRateDate };
