// One tap, one owner. Everything that answers a tap on the map (a vehicle to follow, a landmark to open, a freguesia
// to name) claims it here, in order of priority: live vehicles (pointerup), landmarks (pointerup, after them), then
// whoever listens to the later 'click' event. Check tapClaimed() before acting on a tap; call claimTap() once you have.
let claimedAt = -1e9, claimedBy = '';
export function claimTap(who = '') { claimedAt = performance.now(); claimedBy = who; }
export function tapClaimed(ms = 350) { return performance.now() - claimedAt < ms; }
export function tapOwner() { return tapClaimed() ? claimedBy : ''; }

// what lies under a screen point, for a layer deciding whether to give way (e.g. a passing car vs the palace behind it)
const probes = {};
export function setProbe(name, fn) { probes[name] = fn; }
export function probe(name, x, y) { return probes[name] ? probes[name](x, y) : null; }
if (typeof window !== 'undefined') window.__tapClaimed = tapClaimed;   // for layers that would rather not import this module
