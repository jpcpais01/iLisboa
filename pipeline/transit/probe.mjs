// Realtime formats, sampled by the fetch-transit Action so the sandbox (which can't reach the operators) can see them.
import { writeFileSync, mkdirSync } from 'node:fs';
import { decodeVehicles } from '../../api/_lib/gtfsrt.js';
const P = 'pipeline/transit/probe'; mkdirSync(P, { recursive: true });
const UA = { 'user-agent': 'iLisboa diorama (station cards)' };
async function probe(name, url, as = 'text') {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
    const buf = Buffer.from(await r.arrayBuffer());
    let body = as === 'pb' ? '' : buf.toString('utf8').slice(0, 5000);
    if (as === 'pb' && r.ok) { try { const d = decodeVehicles(buf); body = `header ts ${d.ts}, ${d.vehicles.length} entities\n` + JSON.stringify(d.vehicles.slice(0, 12), null, 0); } catch (e) { body = 'decode: ' + e.message; } }
    writeFileSync(`${P}/rt-${name}.txt`, `${r.status} ${r.headers.get('content-type')} ${buf.length} bytes @ ${new Date().toISOString()}\n${url}\n\n${body}`);
    console.log(name, r.status, buf.length);
    return r.ok ? buf : null;
  } catch (e) { writeFileSync(`${P}/rt-${name}.txt`, `ERR ${e.message}\n${url}`); console.log(name, 'ERR', e.message); return null; }
}
const G = 'https://gateway.carris.pt/gateway/gtfs/api/v2.11/GTFS/realtime';
await probe('carris-vehicles', `${G}/vehiclepositions`, 'pb');
await probe('carris-tripupdates', `${G}/tripupdates`);
await probe('carris-alerts', `${G}/alerts`);
const CM = 'https://api.carrismetropolitana.pt';
const veh = await probe('cm-vehicles', `${CM}/v2/vehicles`);
await probe('cm-stops', `${CM}/v2/stops`);
await probe('cm-lines', `${CM}/v2/lines`);
await probe('cm-arrivals-060001', `${CM}/v2/arrivals/by_stop/060001`);
await probe('cm-arrivals-old', `${CM}/stops/060001/realtime`);
try {
  const v = JSON.parse(veh.toString()).find((x) => x.pattern_id && x.stop_id);
  if (v) {
    await probe('cm-arrivals-live', `${CM}/v2/arrivals/by_stop/${v.stop_id}`);
    await probe('cm-pattern', `${CM}/v2/patterns/${v.pattern_id}`);
    await probe('cm-arrivals-pattern', `${CM}/v2/arrivals/by_pattern/${v.pattern_id}`);
  }
} catch (e) { console.log('cm follow-up', e.message); }
await probe('metro-api', 'https://api.metrolisboa.pt:8243/estadoServicoML/1.0.1/tempoEspera/Estacao/todos');
