// Heads-up display, top left: the "Lisboa" wordmark, then the day, the time and the weather in Lisbon.
// It also owns the clock: by default the scene follows Lisbon's real time (and today's real sun); dragging the
// time slider leaves "live" for any hour of today, and "Agora" goes back. The weather follows the slider too:
// the hour shown is the hour forecast (Open-Meteo, keyless), "agora" when live.
//   const hud = initHud({ onTime(h, now) }) → hud.sunDay(), hud.utcOffset(), hud.hour()
const TZ = 'Europe/Lisbon';
const LAT = 38.7223, LON = -9.1393;
const Q = new URLSearchParams(location.search);

const parts = (d = new Date()) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
}).formatToParts(d).filter((p) => p.type !== 'literal').map((p) => [p.type, +p.value]));
function lisbon(d = new Date()) {
  const p = parts(d);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offset = Math.round((wall - Math.floor(d.getTime() / 1000) * 1000) / 3600000);   // hours ahead of UTC (0 or 1)
  const doy = Math.round((Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(p.year, 0, 0)) / 86400000);
  return { ...p, h: p.hour + p.minute / 60 + p.second / 3600, offset, doy, date: new Date(Date.UTC(p.year, p.month - 1, p.day, 12)) };
}
const WD = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const MO = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const dayLabel = (d) => { const w = WD[d.getUTCDay()]; return `<span class="wd-l">${w}</span><span class="wd-s">${w.slice(0, 3)}</span>, ${d.getUTCDate()} ${MO[d.getUTCMonth()]}`; };
const hhmm = (h) => { h = ((h % 24) + 24) % 24; let H = Math.floor(h), M = Math.round((h - H) * 60); if (M === 60) { H = (H + 1) % 24; M = 0; } return `${H}:${String(M).padStart(2, '0')}`; };

// ─── weather icons (24×24, stroked; the sun is filled amber, drops cobalt) ───
const CLOUD = 'M7.2 19h10.3a4 4 0 0 0 .5-7.97 5.6 5.6 0 0 0-10.8 1.2A3.4 3.4 0 0 0 7.2 19z';
const CLOUD_UP = 'M7.2 15.5h10.3a3.7 3.7 0 0 0 .5-7.36 5.3 5.3 0 0 0-10.2 1.1 3.15 3.15 0 0 0-.6 6.26z';
const SUN = (cx = 12, cy = 12, r = 4, ray = 3) => `<circle class="sun" cx="${cx}" cy="${cy}" r="${r}"/>` + [0, 1, 2, 3, 4, 5, 6, 7].map((k) => {
  const a = (k * Math.PI) / 4, c = Math.cos(a), s = Math.sin(a), r0 = r + 2.2, r1 = r + 2.2 + ray;
  return `<path class="ray" d="M${(cx + c * r0).toFixed(2)} ${(cy + s * r0).toFixed(2)}L${(cx + c * r1).toFixed(2)} ${(cy + s * r1).toFixed(2)}"/>`;
}).join('');
const MOON = (s = 1, x = 0, y = 0) => `<path class="moon" transform="translate(${x} ${y}) scale(${s})" d="M19.5 14.6A8 8 0 1 1 9.4 4.5a6.4 6.4 0 0 0 10.1 10.1z"/>`;
const ICONS = {
  clear: (day) => (day ? SUN() : MOON()),
  partly: (day) => (day ? SUN(8.6, 8.2, 3, 1.9) : MOON(0.62, 1.4, 0.6)) + `<path class="cloud" d="${CLOUD}"/>`,
  cloudy: () => `<path class="cloud" d="M5 9.2a4.6 4.6 0 0 1 8.7-1.4" opacity=".55"/><path class="cloud" d="${CLOUD}"/>`,
  fog: () => '<path class="cloud" d="M4 9h16M3 13h18M5 17h14M8 21h8"/>',
  drizzle: () => `<path class="cloud" d="${CLOUD_UP}"/><path class="drop" d="M9 19v.5M13 19v.5M17 19v.5M11 21.5v.5M15 21.5v.5"/>`,
  rain: () => `<path class="cloud" d="${CLOUD_UP}"/><path class="drop" d="M9 18l-1 3M13 18l-1 3M17 18l-1 3"/>`,
  showers: (day) => (day ? SUN(7.4, 6.6, 2.4, 1.5) : '') + `<path class="cloud" d="${CLOUD_UP}"/><path class="drop" d="M10 18l-1.2 3.4M15 18l-1.2 3.4"/>`,
  snow: () => `<path class="cloud" d="${CLOUD_UP}"/><path class="drop" d="M9 19.5h.01M13 18.5h.01M17 19.5h.01M11 21.5h.01M15 21.5h.01"/>`,
  storm: () => `<path class="cloud" d="${CLOUD_UP}"/><path class="bolt" d="M12.8 15.2 10.6 19h3l-1.8 3.6"/>`,
};
// WMO weather codes → icon + Portuguese words
function wmo(code) {
  if (code === 0) return ['clear', 'Céu limpo'];
  if (code === 1) return ['partly', 'Pouco nublado'];
  if (code === 2) return ['partly', 'Parcialmente nublado'];
  if (code === 3) return ['cloudy', 'Nublado'];
  if (code === 45 || code === 48) return ['fog', 'Nevoeiro'];
  if (code >= 51 && code <= 57) return ['drizzle', 'Chuvisco'];
  if (code >= 61 && code <= 67) return ['rain', code >= 65 ? 'Chuva forte' : 'Chuva'];
  if (code >= 71 && code <= 77) return ['snow', 'Neve'];
  if (code >= 80 && code <= 82) return ['showers', 'Aguaceiros'];
  if (code === 85 || code === 86) return ['snow', 'Aguaceiros de neve'];
  if (code >= 95) return ['storm', 'Trovoada'];
  return ['cloudy', '—'];
}
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

// an azulejo: glazed white tile, cobalt border, a four-petal flower and quarter-flowers in the corners (they meet the next tile's)
const TILE = `<svg class="tile" viewBox="0 0 32 32" aria-hidden="true">
  <rect x="1" y="1" width="30" height="30" rx="3.2" class="glaze"/>
  <g class="paint">
    <path d="M1 7.5A6.5 6.5 0 0 0 7.5 1M31 7.5A6.5 6.5 0 0 1 24.5 1M1 24.5A6.5 6.5 0 0 1 7.5 31M31 24.5A6.5 6.5 0 0 0 24.5 31" fill="none" stroke-width="1.6"/>
    <path d="M16 6.2c2.6 2.6 2.6 5.6 0 8.2-2.6-2.6-2.6-5.6 0-8.2zM16 25.8c2.6-2.6 2.6-5.6 0-8.2-2.6 2.6-2.6 5.6 0 8.2zM6.2 16c2.6-2.6 5.6-2.6 8.2 0-2.6 2.6-5.6 2.6-8.2 0zM25.8 16c-2.6-2.6-5.6-2.6-8.2 0 2.6 2.6 5.6 2.6 8.2 0z"/>
    <circle cx="16" cy="16" r="1.7"/>
    <path d="M3.5 3.5l3 3M28.5 3.5l-3 3M3.5 28.5l3-3M28.5 28.5l-3-3" fill="none" stroke-width="1.3" stroke-linecap="round"/>
  </g>
  <rect x="1" y="1" width="30" height="30" rx="3.2" class="rim"/>
</svg>`;

export function initHud({ onTime }) {
  const el = document.createElement('header');
  el.className = 'hud';
  el.innerHTML = `
    <h1 class="wordmark">${TILE}<span>Lisboa</span></h1>
    <button type="button" class="hud-line" aria-expanded="false" aria-label="Tempo em Lisboa">
      <span class="hud-day"></span><i class="dot-sep"></i><span class="hud-time"><b></b><em class="live-dot" title="ao vivo"></em></span>
      <span class="hud-wx" hidden><i class="dot-sep"></i><svg viewBox="0 0 24 24" aria-hidden="true"></svg><b class="hud-temp"></b></span>
    </button>
    <div class="hud-more" hidden></div>`;
  document.body.appendChild(el);
  const $ = (s) => el.querySelector(s);
  const line = $('.hud-line'), more = $('.hud-more'), wxEl = $('.hud-wx');

  // ─── the clock ───
  const slider = document.getElementById('time'), sunBox = slider.closest('.sun');
  slider.min = 0; slider.max = 24; slider.step = 1 / 60;
  const nowBtn = document.createElement('button');
  nowBtn.type = 'button'; nowBtn.className = 'now'; nowBtn.innerHTML = '<i></i><span>Agora</span>';
  sunBox.querySelector('#clock')?.replaceWith(nowBtn);
  const track = document.createElement('span'); track.className = 'track';
  slider.replaceWith(track); track.appendChild(slider);
  const bubble = document.createElement('output'); bubble.className = 'time-bubble'; track.appendChild(bubble);

  const pinned = parseFloat(Q.get('t'));
  let live = !isFinite(pinned), L = lisbon(), hour = live ? L.h : pinned;
  const setLive = (v) => {
    live = v; el.classList.toggle('live', v); sunBox.classList.toggle('live', v);
    nowBtn.setAttribute('aria-pressed', String(v)); nowBtn.querySelector('span').textContent = v ? 'Ao vivo' : 'Agora';
  };
  function apply(now) {
    slider.value = hour;
    onTime(hour, now, L);
    paintTime(); paintWeather();
  }
  function paintTime() {
    $('.hud-day').innerHTML = dayLabel(L.date);
    $('.hud-time b').textContent = hhmm(hour);
    const pct = (hour / 24) * 100;
    bubble.textContent = hhmm(hour); bubble.style.left = `calc(${pct}% + ${((0.5 - hour / 24) * 18).toFixed(1)}px)`;   // the thumb's centre (18 px thumb)
  }
  // the slider's track is today's sky: night, dawn, day, dusk, night (from the real sunrise and sunset)
  function paintTrack(rise, set) {
    const p = (h) => `${((h / 24) * 100).toFixed(2)}%`;
    const night = 'var(--trk-night)', glow = 'var(--trk-glow)', day = 'var(--trk-day)';
    slider.style.setProperty('--trk', `linear-gradient(90deg, ${night} 0 ${p(rise - 0.7)}, ${glow} ${p(rise)}, ${day} ${p(rise + 1.2)} ${p(set - 1.2)}, ${glow} ${p(set)}, ${night} ${p(set + 0.7)} 100%)`);
  }
  // until the forecast says otherwise, sunrise/sunset come from the sun model itself (via main's onTime): estimate from the date
  { const dec = 23.44 * Math.sin(((2 * Math.PI) / 365) * (L.doy - 81)) * Math.PI / 180, lat = LAT * Math.PI / 180;
    const H = Math.acos(Math.max(-1, Math.min(1, (Math.sin(-0.0145) - Math.sin(lat) * Math.sin(dec)) / (Math.cos(lat) * Math.cos(dec))))) * 12 / Math.PI;
    const noon = 12 - LON / 15 + L.offset; paintTrack(noon - H, noon + H); }

  slider.addEventListener('input', () => { if (live) setLive(false); hour = +slider.value; sunBox.classList.add('drag'); onTime(hour, false, L); paintTime(); paintWeather(); });
  slider.addEventListener('change', () => { hour = +slider.value; sunBox.classList.remove('drag'); apply(true); });
  for (const ev of ['pointerup', 'pointercancel', 'blur']) slider.addEventListener(ev, () => sunBox.classList.remove('drag'));
  nowBtn.addEventListener('click', () => { L = lisbon(); hour = L.h; setLive(true); apply(true); });
  setInterval(() => {
    const nl = lisbon();
    const dayChanged = nl.doy !== L.doy; L = nl;
    if (live) { hour = L.h; apply(true); } else paintTime();
    if (dayChanged) fetchWeather();
  }, 15000);
  setLive(live);

  // ─── weather: Open-Meteo, shared with the weather layers when they publish window.__weather ───
  let W = null;
  try { const c = JSON.parse(localStorage.getItem('ilisboa.wx') || 'null'); if (c && Date.now() - c.t < 6 * 3600e3) W = c.w; } catch { /* private mode */ }
  const take = (w) => {
    if (!w || !(w.hourly?.time || w.current)) return;
    W = w; try { localStorage.setItem('ilisboa.wx', JSON.stringify({ t: Date.now(), w })); } catch { /* full */ }
    const d = W.daily, today = `${L.year}-${String(L.month).padStart(2, '0')}-${String(L.day).padStart(2, '0')}`;
    const k = d?.time?.indexOf(today) ?? -1, hm = (s) => { const m = /T(\d+):(\d+)/.exec(s || ''); return m ? +m[1] + m[2] / 60 : null; };
    if (k >= 0 && hm(d.sunrise?.[k]) != null) paintTrack(hm(d.sunrise[k]), hm(d.sunset[k]));
    paintWeather();
  };
  addEventListener('weather', (e) => take(e.detail || window.__weather));
  let fetchT = 0;
  async function fetchWeather() {
    if (window.__weather?.hourly) return take(window.__weather);
    if (Date.now() - fetchT < 60e3) return; fetchT = Date.now();
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + LAT + '&longitude=' + LON
      + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m,wind_direction_10m,precipitation'
      + '&hourly=temperature_2m,weather_code,is_day,precipitation_probability,wind_speed_10m&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min'
      + '&timezone=Europe%2FLisbon&forecast_days=2&wind_speed_unit=kmh';
    try { const r = await fetch(url); if (r.ok) take(await r.json()); } catch { /* offline: keep the cached forecast */ }
  }
  // the weather layers thread may publish first; otherwise fetch ourselves
  if (window.__weather) take(window.__weather);
  if (W) paintWeather();
  setTimeout(() => { if (!window.__weather) fetchWeather(); }, Q.has('wxnow') ? 0 : 4000);
  setInterval(fetchWeather, 10 * 60e3);

  // the forecast hour under the slider (interpolated), or the current observation when live
  function at(h) {
    const hr = W?.hourly;
    if (!hr?.time) return null;
    const base = `${L.year}-${String(L.month).padStart(2, '0')}-${String(L.day).padStart(2, '0')}T`;
    const i0 = hr.time.indexOf(base + String(Math.floor(h) % 24).padStart(2, '0') + ':00');
    if (i0 < 0) return null;
    const f = h - Math.floor(h), i1 = Math.min(i0 + 1, hr.time.length - 1), near = f < 0.5 ? i0 : i1;
    const lerp = (a) => (a ? a[i0] + (a[i1] - a[i0]) * f : null);
    return { temp: lerp(hr.temperature_2m), code: hr.weather_code?.[near], day: hr.is_day?.[near], pop: hr.precipitation_probability?.[near], wind: lerp(hr.wind_speed_10m) };
  }
  function paintWeather() {
    if (!W) return;
    const c = W.current, useNow = live && c && c.temperature_2m != null;
    const x = useNow ? { temp: c.temperature_2m, code: c.weather_code, day: c.is_day, wind: c.wind_speed_10m } : at(hour);
    if (!x || x.temp == null) { wxEl.hidden = true; return; }
    const [icon, words] = wmo(x.code);
    wxEl.hidden = false;
    wxEl.querySelector('svg').innerHTML = ICONS[icon](x.day !== 0);
    wxEl.dataset.icon = icon;
    $('.hud-temp').textContent = `${Math.round(x.temp)}°`;
    line.title = words;
    // the expanded card
    const rows = [];
    const when = useNow ? 'agora' : hour > L.h ? `previsão às ${hhmm(Math.round(hour))}` : `às ${hhmm(Math.round(hour))}`;
    rows.push(`<p class="cond"><b>${words}</b><span>${when}</span></p>`);
    if (useNow && c.apparent_temperature != null) rows.push(`<p><span>Sensação</span><b>${Math.round(c.apparent_temperature)}°</b></p>`);
    const wind = useNow ? c.wind_speed_10m : x.wind;
    if (wind != null) rows.push(`<p><span>Vento</span><b>${Math.round(wind)} km/h${useNow && c.wind_direction_10m != null ? ' ' + COMPASS[Math.round(c.wind_direction_10m / 45) % 8] : ''}</b></p>`);
    if (useNow && c.relative_humidity_2m != null) rows.push(`<p><span>Humidade</span><b>${Math.round(c.relative_humidity_2m)}%</b></p>`);
    if (!useNow && x.pop != null) rows.push(`<p><span>Chuva</span><b>${Math.round(x.pop)}%</b></p>`);
    const d = W.daily, k = d?.time?.indexOf(`${L.year}-${String(L.month).padStart(2, '0')}-${String(L.day).padStart(2, '0')}`) ?? -1;
    if (k >= 0) {
      if (d.temperature_2m_max) rows.push(`<p><span>Máx · mín</span><b>${Math.round(d.temperature_2m_max[k])}° · ${Math.round(d.temperature_2m_min[k])}°</b></p>`);
      const t = (s) => (s ? s.slice(11, 16).replace(/^0/, '') : '—');
      if (d.sunrise) rows.push(`<p><span>Nascer · pôr do sol</span><b>${t(d.sunrise[k])} · ${t(d.sunset[k])}</b></p>`);
    }
    rows.push('<small>Open-Meteo</small>');
    more.innerHTML = rows.join('');
  }
  line.addEventListener('click', () => {
    if (!W) return;
    const open = more.hidden; more.hidden = !open; line.setAttribute('aria-expanded', String(open));
  });
  addEventListener('pointerdown', (e) => { if (!more.hidden && !el.contains(e.target)) { more.hidden = true; line.setAttribute('aria-expanded', 'false'); } });

  apply(true);
  return {
    sunDay: () => L.doy, utcOffset: () => L.offset, hour: () => hour, live: () => live,
    el,
  };
}
