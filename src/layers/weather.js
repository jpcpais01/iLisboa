// Weather data for the layers and the HUD: one fetch of /api/weather every 10 min (or Open-Meteo directly in dev),
// published as window.__weather plus a 'weather' event, and turned into continuous fields over the city.
//
// Temperature field, honestly: the model lattice (Open-Meteo, 7×5 points, each already at its own real elevation) is
// brought to sea level with the standard lapse rate, interpolated, and brought back down onto the diorama's own terrain,
// so hills read cooler than the valleys and the river by exactly the lapse rate. Then the measured IPMA station readings
// pull it towards reality: each station's error against that field spreads around it (inverse-distance, fading out over
// ~3 km). Stations are measured; everything between them is interpolated.
const LAPSE = 0.0065;   // K per metre (ICAO standard atmosphere)

export function createWeather() {
  let data = null, ground = null;
  const subs = new Set();
  async function load() {
    try {
      const r = await fetch('/api/weather');
      if (!r.ok) throw new Error(r.status);
      data = await r.json();
    } catch {
      // without the API route (vite dev, offline): the city centre straight from Open-Meteo, no lattice or stations
      try {
        const u = 'https://api.open-meteo.com/v1/forecast?latitude=38.7139&longitude=-9.1394&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day&hourly=temperature_2m,weather_code,is_day,precipitation,precipitation_probability,wind_speed_10m,wind_direction_10m&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min&forecast_hours=48&timezone=Europe%2FLisbon';
        const v = await (await fetch(u)).json();
        data = { t: Date.now() / 1000, src: ['Open-Meteo'], current: v.current, hourly: v.hourly, daily: v.daily };
      } catch { return; }
    }
    window.__weather = data;
    dispatchEvent(new CustomEvent('weather', { detail: data }));
    for (const f of subs) f(data);
  }
  load();
  setInterval(load, 10 * 60 * 1000);

  // ─── fields ───
  // bilinear over the lattice (x[i] west→east, y[j] south→north), clamped at the edges
  function lattice(arr, x, y) {
    const g = data.grid, nx = g.nx, ny = g.ny;
    const fi = Math.max(0, Math.min(nx - 1.001, (x - g.x[0]) / (g.x[nx - 1] - g.x[0]) * (nx - 1)));
    const fj = Math.max(0, Math.min(ny - 1.001, (y - g.y[0]) / (g.y[ny - 1] - g.y[0]) * (ny - 1)));
    const i = Math.floor(fi), j = Math.floor(fj), tx = fi - i, ty = fj - j, k = j * nx + i;
    return (arr[k] * (1 - tx) + arr[k + 1] * tx) * (1 - ty) + (arr[k + nx] * (1 - tx) + arr[k + nx + 1] * tx) * ty;
  }
  let seaT = null, resid = [], u = null, v = null, ver = -1;
  function prepare() {
    if (!data?.grid || ver === data.t) return !!data?.grid;
    ver = data.t;
    const g = data.grid;
    seaT = g.T.map((t, k) => t + LAPSE * g.elev[k]);
    // wind blows FROM wd: the flow vector points the other way (x east, y north), in m/s
    u = g.ws.map((s, k) => (-s / 3.6) * Math.sin((g.wd[k] * Math.PI) / 180));
    v = g.ws.map((s, k) => (-s / 3.6) * Math.cos((g.wd[k] * Math.PI) / 180));
    resid = [];
    for (const s of data.stations || []) {
      if (s.T == null) continue;
      const z = ground ? ground.at(s.x, s.y) : 0;
      resid.push({ ...s, r: s.T - (lattice(seaT, s.x, s.y) - LAPSE * z) });
    }
    return true;
  }
  const R0 = 3000;   // m: a station's correction fades over about this distance
  function temp(x, y, z) {
    let t = lattice(seaT, x, y) - LAPSE * z, sw = 1 / (R0 * R0), sr = 0;   // the zero-correction prior weighs like a point R0 away
    for (const s of resid) { const d2 = (s.x - x) ** 2 + (s.y - y) ** 2 + 150 * 150, w = 1 / d2; sw += w; sr += w * s.r; }
    return t + sr / sw;
  }

  return {
    get data() { return data; },
    on(f) { subs.add(f); if (data) f(data); return () => subs.delete(f); },
    setGround(g) { ground = g; ver = -1; },
    ready: () => prepare(),
    temp, wind: (x, y, out) => { out[0] = lattice(u, x, y); out[1] = lattice(v, x, y); return out; },
    lattice: (k, x, y) => lattice(data.grid[k], x, y),
    get stations() { return resid; },
  };
}
