// Transtejo/Soflusa (TTSL) timetable for the boats layer: node pipeline/water/ferry.mjs [gtfs dir]
// → public/water/ferry.json: stops (x, y), routes (code, name, colour), shapes (x, y polylines, metres), services
// (weekdays + date exceptions) and trips [route, shape, service, headsign, [[stop, arr s, dep s, dist m]…]].
// The fetch-water Action runs it weekly after downloading the GTFS, so the timetable rolls forward on its own.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const DIR = process.argv[2] || path.join(ROOT, 'pipeline/water/raw/ferry');
const LAT0 = 38.71375, LON0 = -9.13975, P = (LAT0 * Math.PI) / 180;
const M_LAT = 111132.92 - 559.82 * Math.cos(2 * P) + 1.175 * Math.cos(4 * P), M_LON = 111412.84 * Math.cos(P) - 93.5 * Math.cos(3 * P);
const fwd = (lat, lon) => [Math.round((lon - LON0) * M_LON), Math.round((lat - LAT0) * M_LAT)];

function csv(f) {
  const p = path.join(DIR, f);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const head = lines[0].split(',');
  return lines.slice(1).map((l) => {
    const v = []; let cur = '', q = false;
    for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { v.push(cur); cur = ''; } else cur += ch; }
    v.push(cur);
    return Object.fromEntries(head.map((h, i) => [h, v[i] ?? '']));
  });
}
const secs = (t) => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };

const stops = {}, stopList = [];
for (const s of csv('stops.txt')) { stops[s.stop_id] = stopList.length; stopList.push({ name: s.stop_name, c: fwd(+s.stop_lat, +s.stop_lon) }); }
const routes = {}, routeList = [];
for (const r of csv('routes.txt')) { routes[r.route_id] = routeList.length; routeList.push({ code: r.route_short_name, name: r.route_long_name, col: '#' + (r.route_color || '1d4f91') }); }
const shapePts = {};
for (const s of csv('shapes.txt')) (shapePts[s.shape_id] ??= []).push([+s.shape_pt_sequence, ...fwd(+s.shape_pt_lat, +s.shape_pt_lon)]);
const shapes = {}, shapeList = [];
for (const [id, pts] of Object.entries(shapePts)) { shapes[id] = shapeList.length; shapeList.push(pts.sort((a, b) => a[0] - b[0]).map((p) => [p[1], p[2]])); }

const services = {};
for (const c of csv('calendar.txt')) services[c.service_id] = { d: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((k) => +c[k]), from: +c.start_date, to: +c.end_date, add: [], del: [] };
for (const c of csv('calendar_dates.txt')) {
  const s = (services[c.service_id] ??= { d: [0, 0, 0, 0, 0, 0, 0], from: 0, to: 0, add: [], del: [] });
  (c.exception_type === '1' ? s.add : s.del).push(+c.date);
}
const times = {};
for (const st of csv('stop_times.txt')) (times[st.trip_id] ??= []).push([+st.stop_sequence, stops[st.stop_id], secs(st.arrival_time), secs(st.departure_time), +st.shape_dist_traveled || 0]);
const trips = [];
for (const t of csv('trips.txt')) {
  const tt = times[t.trip_id];
  if (!tt || tt.length < 2 || routes[t.route_id] == null) continue;
  tt.sort((a, b) => a[0] - b[0]);
  trips.push([routes[t.route_id], shapes[t.shape_id] ?? -1, t.service_id, t.trip_headsign, tt.map((s) => s.slice(1))]);
}
const out = { src: 'TTSL – Transtejo Soflusa GTFS (via Mobility Database)', stops: stopList, routes: routeList, shapes: shapeList, services, trips };
fs.mkdirSync(path.join(ROOT, 'public/water'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'public/water/ferry.json'), JSON.stringify(out));
console.log(`ferry.json: ${stopList.length} stops, ${routeList.length} routes, ${shapeList.length} shapes, ${Object.keys(services).length} services, ${trips.length} trips, ${fs.statSync(path.join(ROOT, 'public/water/ferry.json')).size} B`);
