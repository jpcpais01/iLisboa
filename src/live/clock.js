// Lisbon wall-clock for the modelled parts (Metro timetable, typical traffic). ?livehour=18.5 pins it for testing.
const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Lisbon', hour12: false, weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric' });
const pin = parseFloat(new URLSearchParams(location.search).get('livehour'));
const t0 = performance.now();
// { sec: seconds into the service day (past midnight counts as 24h+ of the day before), weekend }
export function lisbonNow() {
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  let sec = isFinite(pin) ? pin * 3600 + (performance.now() - t0) / 1000 : (+p.hour % 24) * 3600 + +p.minute * 60 + +p.second + (Date.now() % 1000) / 1000;
  let day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  if (sec < 3 * 3600) { sec += 86400; day = (day + 6) % 7; }
  return { sec, h: sec / 3600, weekend: day === 0 || day === 6 };
}
