// Assistant eval: every case in cases.mjs against each model, on one recorded snapshot of the live feeds, graded by a
// stronger model against the case rubric and the exact tool results the assistant saw.
//   ANTHROPIC_API_KEY=… node pipeline/assistant/eval.mjs --models claude-haiku-5-5,claude-sonnet-5-5 --fixtures fx.json [--only id,id] [--runs 1]
// Writes pipeline/assistant/results/<stamp>.json and prints a table. Web search cases hit the real web (server side).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { runAssistant } from '../../api/_lib/assistant/agent.js';
import { makeGetter } from '../../api/_lib/assistant/data.js';
import { fixtureFetch, missing } from './fixture-fetch.mjs';
import { CASES } from './cases.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const models = arg('models', 'claude-haiku-5-5').split(',');
const effort = arg('effort', 'low');
const fx = JSON.parse(readFileSync(arg('fixtures', 'pipeline/assistant/fixtures.json'), 'utf8'));
const only = arg('only', '') ? arg('only').split(',') : null;
const runs = +arg('runs', 1), judgeModel = arg('judge', 'claude-opus-5-5'), noJudge = process.argv.includes('--no-judge');
const key = process.env.ANTHROPIC_API_KEY;
const judge = new Anthropic({ apiKey: key });
// a callsign that is really in the snapshot, for the flight-route case
const planes = fx.urls['/api/planes']?.a || [];
const CALL = fx.call || (planes.find((p) => /^TAP/.test(p[1]) && p[6] > 0) || planes.find((p) => p[1] && p[6] > 0) || [])[1] || 'TAP1234';
const PRICE = { 'claude-haiku-5-5': [0.10, 0.50], 'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20] };

const SCHEMA = { type: 'object', additionalProperties: false, required: ['grounded', 'correct', 'style', 'pass', 'why'], properties: {
  grounded: { type: 'boolean', description: 'Every concrete fact/number about now (times, positions, temperatures, counts, populations) is supported by the tool results or web results; nothing invented.' },
  correct: { type: 'boolean', description: 'The answer does what the rubric asks and is factually right.' },
  style: { type: 'boolean', description: 'Right language (European Portuguese for PT questions, English for EN), concise for a phone chat, friendly.' },
  pass: { type: 'boolean', description: 'grounded AND correct (style problems alone do not fail).' },
  why: { type: 'string', description: 'One or two sentences.' } } };

async function grade(c, q, out, trace) {
  const toolsTxt = trace.map((t) => `### ${t.name}(${JSON.stringify(t.input)})\n${JSON.stringify(t.result).slice(0, 5000)}`).join('\n\n') || '(no app tools called)';
  const r = await judge.messages.create({
    model: judgeModel, max_tokens: 1500, output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: `You grade answers of "Alfacinha", a Lisbon city assistant inside a 3D map app. It has app tools (results below, the ground truth for live data) and web search (its results are not shown here: judge web-based claims on plausibility and hedging, and on your own knowledge for well-known facts).\n\nSnapshot time (Lisbon): ${new Date(fx.at * 1000).toLocaleString('en-GB', { timeZone: 'Europe/Lisbon' })}\n\nQUESTION: ${q}\n\nRUBRIC: ${c.rubric}\n\nAPP TOOL CALLS AND RESULTS:\n${toolsTxt}\n\nWEB SEARCHES: ${out.usage.web_searches}\nMAP ACTIONS: ${JSON.stringify(out.actions)}\n\nANSWER:\n${out.text}` }],
  });
  return JSON.parse(r.content.find((b) => b.type === 'text').text);
}

const rows = [];
for (const model of models) for (const c of CASES) {
  if (only && !only.includes(c.id)) continue;
  for (let k = 0; k < runs; k++) {
    const q = c.q.replace('{CALLSIGN}', CALL);
    const trace = [];
    const ctx = { origin: 'http://app.local', get: makeGetter(fixtureFetch(fx)), now: () => new Date(fx.at * 1000), onTool: (name, input, result) => trace.push({ name, input, result }) };
    const t0 = Date.now(); let first = 0;
    let out;
    const lang = /^[A-Z][a-z]+ (is|are|was|what|when|who)|^(What|When|Who|Where|How|Is|Are|Show|Which)\b/.test(q) ? 'en-GB' : 'pt-PT';
    try {
      out = await runAssistant({ apiKey: key, model, effort, messages: [{ role: 'user', content: q }], state: { lang, ...(c.state || {}) }, ctx, emit: (e) => { if (e.t === 'text' && !first) first = Date.now() - t0; } });
    } catch (e) { out = { text: 'ERROR ' + (e.message || e), usage: { input: 0, output: 0, web_searches: 0, tools: [] }, actions: [] }; }
    const ms = Date.now() - t0;
    const called = new Set([...trace.map((t) => t.name), ...(out.usage.web_searches ? ['web_search'] : []), ...out.actions.map((a) => ({ show: 'show_on_map', layer: 'set_layer', follow: 'follow_vehicle' }[a.type]))]);
    const toolsOk = c.tools.every((alts) => alts.some((t) => called.has(t)));
    let g = { pass: true, why: '(not judged)' };
    if (!noJudge) try { g = await grade(c, q, out, trace); } catch (e) { g = { pass: false, why: 'judge error ' + e.message }; }
    const [pi, po] = PRICE[model] || [0, 0];
    const cost = (out.usage.input * pi + out.usage.output * po) / 1e6 + out.usage.web_searches * 0.01;
    const row = { model, id: c.id, run: k, q, pass: !!g.pass && toolsOk, toolsOk, ...g, ms, first_text_ms: first, cost: Math.round(cost * 1e5) / 1e5, usage: out.usage, actions: out.actions, answer: out.text, trace: trace.map((t) => ({ name: t.name, input: t.input })) };
    rows.push(row);
    console.log(`${row.pass ? 'PASS' : 'FAIL'} ${model.padEnd(18)} ${c.id.padEnd(15)} ${String(ms).padStart(6)} ms  $${row.cost.toFixed(4)}  ${toolsOk ? '' : '[missing tool] '}${g.why}`);
  }
}
const sum = {};
for (const r of rows) { const s = (sum[r.model] ||= { n: 0, pass: 0, ms: [], cost: 0 }); s.n++; s.pass += r.pass; s.ms.push(r.ms); s.cost += r.cost; }
console.log('\nmodel               pass     median ms   p90 ms   $/answer');
for (const [m, s] of Object.entries(sum)) { s.ms.sort((a, b) => a - b); console.log(`${m.padEnd(18)} ${String(s.pass).padStart(2)}/${s.n}   ${String(s.ms[Math.floor(s.n / 2)]).padStart(8)}   ${String(s.ms[Math.floor(s.n * 0.9)]).padStart(6)}   ${(s.cost / s.n).toFixed(4)}`); }
if (missing.size) console.log('\nMISSING FIXTURES:\n' + [...missing].join('\n'));
mkdirSync('pipeline/assistant/results', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
writeFileSync(`pipeline/assistant/results/${stamp}.json`, JSON.stringify({ at: fx.at, models, effort, judge: judgeModel, summary: sum, rows }, null, 1));
console.log('→ pipeline/assistant/results/' + stamp + '.json');
