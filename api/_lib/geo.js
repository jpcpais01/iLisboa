// Shared with the viewer and pipeline: local tangent plane around the diorama origin (x east, y north, metres).
const LAT0 = 38.71375, LON0 = -9.13975, P = (LAT0 * Math.PI) / 180;
const M_LAT = 111132.92 - 559.82 * Math.cos(2 * P) + 1.175 * Math.cos(4 * P), M_LON = 111412.84 * Math.cos(P) - 93.5 * Math.cos(3 * P);
export const fwd = (lat, lon) => [(lon - LON0) * M_LON, (lat - LAT0) * M_LAT];
// the live layers cover the diorama with a margin (vehicles drive in from just outside)
export const BBOX = { S: 38.66, W: -9.27, N: 38.80, E: -9.05 };
export const inBox = (lat, lon) => lat > BBOX.S && lat < BBOX.N && lon > BBOX.W && lon < BBOX.E;
export const r1 = (v) => Math.round(v * 10) / 10;
