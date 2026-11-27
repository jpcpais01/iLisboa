// The assistant's loop, shared by the Vercel route (api/assistant.js) and the eval (pipeline/assistant/eval.mjs).
// One turn: stream the model; when it calls our tools, run them (in parallel), feed the results back, repeat.
// Web search runs on Anthropic's side (server tool) inside the same stream.
import Anthropic from '@anthropic-ai/sdk';
import { TOOL_DEFS, TOOL_LABELS, runTool, lisbonClock } from './tools.js';

export const DEFAULT_MODEL = 'claude-haiku-5-5';

export const SYSTEM = `You are Alfacinha, the guide who lives inside iLisboa, a live 3D model of Lisbon (the whole city and the river banks, from Amadora and Odivelas to Almada, Seixal and Barreiro). "Alfacinha" is what Lisbon natives are called. You're a little ceramic swallow (andorinha), like the ones on Lisbon's façades: warm, calm, witty in a quiet way, and precise.

What you know comes from the app's own data, through your tools:
- live Carris buses, trams (elétricos) and funiculars, and Carris Metropolitana buses (GPS, every ~15 s); stop timetables and Carris Metropolitana real-time arrivals; the Metro (typical timetable: the Metro publishes no live positions);
- live planes (ADS-B) and flight routes; live road traffic (TomTom);
- weather at any point (Open-Meteo model + IPMA station readings) and the 7-day forecast;
- every parish (freguesia) with population, area and density (INE Census 2021), and municipalities;
- ~760 landmarks with their Wikipedia articles; places, stops and streets by name;
- and you can move the 3D camera (show_on_map), switch map layers (set_layer) and follow a vehicle (follow_vehicle).
For anything else (news, events, opening hours, prices, history beyond Wikipedia, restaurants, strikes) use web_search.

Rules for being right:
1. Any number about now (vehicle positions, arrivals, weather, traffic, planes, populations) must come from a tool result in this turn. Never guess or remember them. If a tool fails or has no data, say so plainly and offer the next best thing.
2. Resolve places with find_place before tools that need coordinates or stop ids. Stops with the same name are usually the two sides of the street: check the ones that matter.
3. Say how fresh and how certain things are, briefly: "ao vivo", "pelo horário", "estimado". Times are Lisbon local time.
4. If the question is ambiguous (which stop? which direction?), answer the most likely reading and mention the alternative in one short line; don't stall with questions.
5. Don't invent landmarks, lines or stops. Carris lines: numbers like 728, 736; trams end in E (28E, 15E); funiculars/lifts are 50E+ (Elevador da Glória 51E, Bica 53E, Lavra 52E, Santa Justa 54E). Carris Metropolitana lines have 4 digits (e.g. 3001).

How to talk:
- Reply in the user's language. In Portuguese, use European Portuguese (Portugal: "autocarro", "elétrico", "comboio", "tu" is fine), never Brazilian forms.
- Short and calm: usually 1–4 sentences, or a tight list for arrivals and rankings. It's a small chat on a phone. Light markdown only (bold, short lists), no tables, no headings.
- When you show something on the map, say so in a few words. Use show_on_map when the user asks to see/go somewhere or when the answer is about a specific place they'd want to look at.
- You can be a little charming about Lisbon (a saudade here, a pastel de nata there), never at the cost of the answer.`;

// the per-request state of the viewer: where the camera is, what's selected, the time
export function stateNote(s = {}, now = new Date()) {
  const c = lisbonClock(now), L = [];
  L.push(`Now in Lisbon: ${c.weekday} ${c.date}, ${c.hm}.`);
  if (s.view && isFinite(s.view.lat)) L.push(`The 3D camera is looking at ${(+s.view.lat).toFixed(4)}, ${(+s.view.lon).toFixed(4)} from ~${Math.round(+s.view.range || 0)} m${s.view.parish ? ` (${s.view.parish})` : ''}. "Here" / "aqui" means this spot unless the user says otherwise.`);
  if (s.hour != null && !s.live) L.push(`The time slider is set to ${s.hour} (the user is previewing that hour; live data is still for now).`);
  if (s.selected) L.push(`Selected landmark card: ${s.selected}.`);
  if (s.following) L.push(`The camera is following: ${s.following}.`);
  if (s.layers?.length) L.push(`Layers on: ${s.layers.join(', ')}.`);
  if (s.lang) L.push(`Browser language: ${s.lang}.`);
  return `<app_state>\n${L.join('\n')}\n</app_state>`;
}

function tools(model) {
  const ws = { type: /haiku/.test(model) ? 'web_search_20250305' : 'web_search_20260209', name: 'web_search', max_uses: 3, user_location: { type: 'approximate', city: 'Lisbon', region: 'Lisboa', country: 'PT', timezone: 'Europe/Lisbon' } };
  return [...TOOL_DEFS, ws];
}

// messages: [{role:'user'|'assistant', content: string}] (the browser keeps plain text history)
// emit(event): {t:'text', d} | {t:'tool', name, label} | {t:'action', ...} | {t:'sources', list} | {t:'done', usage}
export async function runAssistant({ apiKey, model = DEFAULT_MODEL, effort = 'low', messages, state, ctx, emit, maxSteps = 8, signal }) {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 45000 });
  const lang = /^pt/i.test(state?.lang || 'pt') ? 0 : 1;
  const msgs = messages.map((m) => ({ role: m.role, content: String(m.content) }));
  msgs.push({ role: 'system', content: stateNote(state, ctx.now()) });   // mid-conversation operator note: keeps the cached prefix
  const actions = [];
  ctx.action = (a) => { actions.push(a); emit({ t: 'action', ...a }); };
  const usage = { input: 0, output: 0, cache_read: 0, web_searches: 0, steps: 0, tools: [] };
  const sources = new Map();
  let text = '';
  for (let step = 0; step < maxSteps; step++) {
    usage.steps++;
    const stream = client.messages.stream({
      model, max_tokens: 2048,
      output_config: { effort },
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: tools(model), messages: msgs,
    }, { signal });
    stream.on('streamEvent', (ev) => {
      if (ev.type === 'content_block_start') {
        const b = ev.content_block;
        if (b.type === 'tool_use' || b.type === 'server_tool_use') emit({ t: 'tool', name: b.name, label: (TOOL_LABELS[b.name] || [b.name, b.name])[lang] });
      } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        text += ev.delta.text; emit({ t: 'text', d: ev.delta.text });
      } else if (ev.type === 'content_block_delta' && ev.delta.type === 'citations_delta') {
        const c = ev.delta.citation; if (c?.url && !sources.has(c.url)) sources.set(c.url, { url: c.url, title: c.title || new URL(c.url).hostname });
      }
    });
    const msg = await stream.finalMessage();
    usage.input += msg.usage.input_tokens || 0; usage.output += msg.usage.output_tokens || 0;
    usage.cache_read += msg.usage.cache_read_input_tokens || 0; usage.web_searches += msg.usage.server_tool_use?.web_search_requests || 0;
    if (msg.stop_reason === 'refusal') { const t = lang ? "I can't help with that one." : 'Nisso não posso ajudar.'; text += t; emit({ t: 'text', d: t }); break; }
    if (msg.stop_reason === 'pause_turn') { msgs.push({ role: 'assistant', content: msg.content }); continue; }
    const calls = msg.content.filter((b) => b.type === 'tool_use');
    if (msg.stop_reason !== 'tool_use' || !calls.length) break;
    msgs.push({ role: 'assistant', content: msg.content });
    const results = await Promise.all(calls.map(async (b) => {
      const r = await runTool(b.name, b.input, ctx);
      ctx.onTool?.(b.name, b.input, r);
      usage.tools.push({ name: b.name, input: b.input, error: r?.error });
      return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(r), ...(r?.error ? { is_error: true } : {}) };
    }));
    msgs.push({ role: 'user', content: results });
    if (step === maxSteps - 2) msgs.push({ role: 'system', content: 'Last step: answer now with what you have, no more tools.' });
    if (text && !text.endsWith('\n')) { text += '\n\n'; emit({ t: 'text', d: '\n\n' }); }   // keep a pre-tool sentence apart from the answer
  }
  if (sources.size) emit({ t: 'sources', list: [...sources.values()].slice(0, 5) });
  emit({ t: 'done', usage: { ...usage, tools: usage.tools.map((t) => t.name) } });
  return { text, usage, actions, sources: [...sources.values()] };
}
