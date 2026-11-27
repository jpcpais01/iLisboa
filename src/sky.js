// Sky, sun and air: one physical atmosphere drives everything the light touches.
//
//  · a small sky-view table (128×64) is ray-marched on the GPU through a real atmosphere (Rayleigh air, Mie haze, ozone; Earth
//    numbers from Hillaire 2020) whenever the sun moves, a few hundred µs. Each frame the sky costs one lookup per sky pixel;
//  · the same sky, without clouds or sun disc, is baked into the environment map (PMREM): it is the ambient light, the river's
//    reflection and the colour of the haze, so all four always agree. Sunset tints come out of the physics, not out of a palette;
//  · the sun's own colour and strength are its transmittance through that air (computed on the CPU from the same numbers);
//  · haze is height fog integrated along each view ray (thick in the low air, thin above it) in the sky's own colour for that
//    direction, applied before tone mapping, so the far city goes blue at noon, gold towards a low sun and dark at night;
//  · clouds are a thin deck of fair-weather cumulus drawn on the sky pixels only (2–4 octaves of value noise), lit by the
//    sun as the deck sees it, so they stay pink a few minutes after the street is in shadow, and glow orange over the city at night.
import * as THREE from 'three';

// ─── atmosphere (metres) ────────────────────────────────────────────────────────────────────────────────────────────────
const RE = 6360e3, RA = 6460e3;
const BR = [5.802e-6, 13.558e-6, 33.1e-6], HR = 8000;
const BM = 3.996e-6, AM = 4.4e-6, HM = 1200;
const OZ = [0.65e-6, 1.881e-6, 0.085e-6];
export const HAZE = 2.2;   // Mie density × Earth average: Lisbon's sea air is hazier than the standard atmosphere
const CAM_ALT = 150;       // the sky is seen from about this height (the city's hills, a bridge deck, a low plane)

const GLSL_ATMO = /* glsl */`
const float RE = ${RE.toFixed(1)}, RA = ${RA.toFixed(1)};
const vec3 BR = vec3(${BR.map((x) => x.toExponential(4)).join(',')});
const float BM = ${BM.toExponential(4)}, AM = ${AM.toExponential(4)};
const vec3 OZ = vec3(${OZ.map((x) => x.toExponential(4)).join(',')});
uniform float uMie;
float tExit(vec3 ro, vec3 rd, float r) { float b = dot(ro, rd), c = dot(ro, ro) - r * r, d = b * b - c; return d < 0. ? -1. : -b + sqrt(d); }
float tGround(vec3 ro, vec3 rd) { float b = dot(ro, rd), c = dot(ro, ro) - RE * RE, d = b * b - c; if (d < 0.) return -1.; float t = -b - sqrt(d); return t > 0. ? t : -1.; }
void medium(float h, out vec3 sR, out float sM, out vec3 ext) {
  float dr = exp(-h / ${HR.toFixed(1)}), dm = exp(-h / ${HM.toFixed(1)}) * uMie, dz = max(0., 1. - abs(h - 25000.) / 15000.);
  sR = BR * dr; sM = BM * dm; ext = sR + (BM + AM) * dm + OZ * dz;
}
vec3 sunTrans(vec3 p, vec3 s) {   // transmittance from p to the sun (0 behind the planet)
  if (tGround(p, s) > 0.) return vec3(0.);
  float tm = tExit(p, s, RA), dt = tm / 8.; vec3 od = vec3(0.), sR, e; float sM;
  for (int i = 0; i < 8; i++) { vec3 q = p + s * (float(i) + .5) * dt; medium(length(q) - RE, sR, sM, e); od += e * dt; }
  return exp(-od);
}`;

// sky-view table: u = azimuth from the sun (0 … π), v = elevation (−90° … 90°, packed towards the horizon)
const LUT_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform vec3 uSun;
${GLSL_ATMO}
void main() {
  float az = vUv.x * 3.14159265, l = vUv.y * 2. - 1., el = sign(l) * l * l * 1.5707963;
  vec3 rd = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
  vec3 sun = normalize(vec3(sqrt(max(0., 1. - uSun.y * uSun.y)), uSun.y, 0.));
  vec3 ro = vec3(0., RE + ${CAM_ALT.toFixed(1)}, 0.);
  float tg = tGround(ro, rd), tm = tg > 0. ? tg : tExit(ro, rd, RA);
  float mu = dot(rd, sun), pR = .0596831 * (1. + mu * mu), g = .8, pM = .0795775 * (1. - g * g) / pow(1. + g * g - 2. * g * mu, 1.5);
  vec3 L = vec3(0.), T = vec3(1.), sR, e; float sM, tp = 0.;
  const int N = 28;
  for (int i = 0; i < N; i++) {
    float tn = tm * pow((float(i) + 1.) / float(N), 2.), dt = tn - tp, t = tp + dt * .5; tp = tn;
    vec3 p = ro + rd * t; float h = length(p) - RE;
    medium(h, sR, sM, e);
    vec3 up = p / length(p), Ts = sunTrans(p, sun);
    // single scattering + an isotropic stand-in for the multiple scattering that keeps the twilight sky blue
    vec3 ms = (sR + sM) * .07 * sunTrans(p, normalize(up + sun * .5) ) * max(0., dot(up, sun) + .25);
    vec3 S = (sR * pR + sM * pM) * Ts + ms;
    vec3 Ti = exp(-e * dt);
    L += T * (S - S * Ti) / max(e, vec3(1e-9));   // energy-conserving step (Hillaire)
    T *= Ti;
  }
  if (tg > 0.) {   // below the horizon: the ground seen through the air, lit by the sun and a share of the sky
    vec3 p = ro + rd * tg, up = normalize(p);
    L += T * .12 / 3.14159 * (sunTrans(p, sun) * max(0., dot(up, sun)) + .08 * smoothstep(-.1, .3, sun.y));
  }
  gl_FragColor = vec4(L, 1.);
}`;

// shared sky radiance for a world direction (no sun disc, no clouds): the environment and the dome use it
const SKY_COMMON = /* glsl */`
uniform sampler2D uLut; uniform vec3 uSunW; uniform float uSunE; uniform vec3 uNightSky; uniform vec3 uGlow;
vec3 skyRad(vec3 d) {
  vec2 h = d.xz, s = uSunW.xz; float hl = length(h), sl = length(s);
  float c = (hl > 1e-4 && sl > 1e-4) ? dot(h, s) / (hl * sl) : 1.;
  float el = asin(clamp(d.y, -1., 1.)), v = .5 + .5 * sign(el) * sqrt(abs(el) / 1.5707963);
  vec3 L = texture2D(uLut, vec2(acos(clamp(c, -1., 1.)) / 3.14159265, v)).rgb * uSunE;
  // night: a faint moonlit blue overhead and the city's sodium glow on the low air
  float up = max(d.y, 0.);
  L += uNightSky * (.35 + .65 * up) + uGlow * exp(-max(d.y, 0.) * 14.);
  return L;
}`;

const DOME_VERT = /* glsl */`
varying vec3 vDir;
uniform mat4 uInvVP;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2. - 1.;   // one triangle covering the screen
  vec4 w = uInvVP * vec4(p, 1., 1.);
  vDir = w.xyz / w.w - cameraPosition;
  gl_Position = vec4(p, 1., 1.);   // on the far plane: drawn only where nothing else is
}`;

const DOME_FRAG = /* glsl */`
varying vec3 vDir;
uniform vec3 uSunDisc, uSunCloud, uAmbCloud; uniform float uCover, uTime, uStars, uCloudGlow;
${SKY_COMMON}
float h2(vec2 p) { vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
void main() {
  vec3 d = normalize(vDir);
  // below the horizon (past the edge of the map) the eye meets only haze: the horizon's own colour, a touch deeper
  vec3 col = d.y >= 0. ? skyRad(d) : skyRad(normalize(vec3(d.x, 0., d.z))) * (1. - .25 * smoothstep(0., -.25, d.y));
  float mu = dot(d, uSunW);
  // the sun: a disc with a darkened limb, and a tight glare the eye sees around it
  float r = acos(clamp(mu, -1., 1.)) / .0068;
  col += uSunDisc * (smoothstep(1.1, .9, r) * (1. - .5 * (1. - sqrt(max(0., 1. - r * r * .8)))) * 40. + exp(-r * .9) * .25 + exp(-r * .12) * .02);
  // stars, above the haze, only at night
  if (uStars > 0. && d.y > 0.) {
    vec2 sp = vec2(atan(d.z, d.x), asin(d.y)) * 260.;
    vec2 ci = floor(sp); float hh = h2(ci);
    if (hh > .985) { vec2 o = vec2(h2(ci + 7.), h2(ci + 13.)) * .6 + .2; float s = smoothstep(.22, 0., length(fract(sp) - o));
      col += vec3(.9, .92, 1.) * s * (hh - .985) * 60. * uStars * smoothstep(0., .25, d.y); }
  }
  // clouds: a thin deck at 1.8 km, drifting on a westerly
  if (uCover > 0. && d.y > .015) {
    float t = (1800. - cameraPosition.y) / d.y;
    vec2 p = (cameraPosition.xz + d.xz * t) / 2600. + vec2(uTime * .004, uTime * .0011);
    float n = vn(p) * .5 + vn(p * 2.03 + 1.7) * .25;
#ifndef SKY_LITE
    n += vn(p * 4.1 + 3.1) * .125 + vn(p * 8.3 + 5.3) * .0625;
#else
    n += .09;
#endif
    float dens = smoothstep(1. - uCover, 1.15 - uCover * .7, n);
    if (dens > 0.) {
      float far = exp(-t / 42000.) * smoothstep(.015, .09, d.y);
      float fwd = .5 + 1.6 * pow(max(mu, 0.), 6.);   // silver lining towards the sun
      vec3 lit = uSunCloud * (.16 + .1 * fwd) * exp(-dens * 1.3) + uAmbCloud * (1. - .35 * dens) + uGlow * uCloudGlow * dens;
      col = mix(col, lit, dens * far * .92);
    }
  }
  gl_FragColor = vec4(col, 1.);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const ENV_FRAG = /* glsl */`
varying vec3 vW;
uniform vec3 uGround;
${SKY_COMMON}
void main() {
  vec3 d = normalize(vW);
  vec3 c = d.y >= 0. ? skyRad(d) : mix(skyRad(vec3(d.x, 0., d.z)), uGround, smoothstep(0., -.08, d.y));   // ground bounce below the horizon
  gl_FragColor = vec4(c, 1.);
}`;

// ─── haze: fog becomes aerial perspective, applied before tone mapping ──────────────────────────────────────────────────
// Density falls off with height (scale height ~1 km): a low view looks through the thick bottom of the haze, a high one
// through little. The colour is the sky's own in that direction (from the environment map), or the fog colour without one.
THREE.ShaderChunk.fog_pars_vertex = '#ifdef USE_FOG\nvarying vec3 vFogRel;\n#endif';
THREE.ShaderChunk.fog_vertex = '#ifdef USE_FOG\nvFogRel = (vec4(mvPosition.xyz, 0.) * viewMatrix).xyz;\n#endif';
THREE.ShaderChunk.fog_pars_fragment = '#ifdef USE_FOG\nuniform vec3 fogColor; uniform float fogDensity; varying vec3 vFogRel;\n#endif';
THREE.ShaderChunk.fog_fragment = '';
THREE.ShaderChunk.tonemapping_fragment = /* glsl */`
#ifdef USE_FOG
{
  float fd = length(vFogRel); vec3 fdir = vFogRel / max(fd, 1e-3);
  float k = 1. / 1000., ry = fdir.y * fd * k;
  float od = fogDensity * fd * exp(-max(cameraPosition.y, 0.) * k) * (abs(ry) > 1e-3 ? (1. - exp(-ry)) / ry : 1. - ry * .5);
  float ff = 1. - exp(-od);
  if (ff > .002) {   // the near city (most pixels) skips the sky lookup
  #ifdef ENVMAP_TYPE_CUBE_UV
  vec3 fc = textureCubeUV(envMap, envMapRotation * vec3(fdir.x, max(fdir.y, .01) * .5, fdir.z), 0.).rgb;
  #else
  vec3 fc = fogColor;
  #endif
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fc, ff);
  }
}
#endif
#if defined( TONE_MAPPING )
gl_FragColor.rgb = toneMapping( gl_FragColor.rgb );
#endif`;

// ─── grade: the film the light is shot on ──────────────────────────────────────────────────────────────────────────────
// ACES crushes the shade into its toe and pulls saturated colours (terracotta roofs, trees, the blue sky) towards grey, which
// reads as flat and muddy. This is a hue-preserving curve (Khronos PBR Neutral's shoulder) after a gentle log-space contrast
// around mid-grey and a little vibrance; the gain keeps the exposure calibration made for ACES (mid-grey lands where it did).
const GQ = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const G = { gain: +GQ.get('gg') || 1.08, con: +GQ.get('gc') || 1.2, sat: +GQ.get('gs') || 1.2, warm: GQ.has('gw') ? +GQ.get('gw') : 0.035 };
THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace('vec3 CustomToneMapping( vec3 color ) { return color; }', /* glsl */`
vec3 CustomToneMapping( vec3 color ) {
  color *= toneMappingExposure * ${(G.gain * 1.41).toFixed(4)};
  float L = dot( color, vec3( .2126, .7152, .0722 ) );
  // contrast in log space about mid-grey (luminance only, so hues hold), then vibrance: duller colours gain more
  float Lc = .18 * pow( max( L, 1e-6 ) / .18, ${G.con.toFixed(3)} );
  color *= Lc / max( L, 1e-6 ); L = Lc;
  vec3 ch = color - L; float s = max( abs( ch.r ), max( abs( ch.g ), abs( ch.b ) ) ) / max( L, 1e-4 );
  color = max( vec3( 0. ), L + ch * mix( ${G.sat.toFixed(3)}, 1., smoothstep( .2, 1.2, s ) ) );
  // a breath of warmth in the sunlit tones and cool in the shade (split toning, as sunlit film reads)
  float t = smoothstep( .02, .4, L ) * ( 1. - .7 * smoothstep( .7, 2., L ) );   // sunlit mid-tones warm; glare and sky stay neutral
  color *= mix( vec3( 1. - ${G.warm.toFixed(3)}, 1., 1. + ${G.warm.toFixed(3)} ), vec3( 1. + ${G.warm.toFixed(3)}, 1., 1. - ${G.warm.toFixed(3)} * 1.5 ), t );
  // Khronos PBR Neutral shoulder
  const float SC = .8 - .04, DS = .15;
  float x = min( color.r, min( color.g, color.b ) ), off = x < .08 ? x - 6.25 * x * x : .04;
  color -= off;
  float peak = max( color.r, max( color.g, color.b ) );
  if ( peak < SC ) return color;
  float d = 1. - SC, np = 1. - d * d / ( peak + d - SC );
  color *= np / peak;
  return mix( color, vec3( np ), 1. - 1. / ( DS * ( peak - np ) + 1. ) );
}`);

// ─── shadows: two cascades on one sun ──────────────────────────────────────────────────────────────────────────────────
// Light 0 (the sun) carries the sharp near map; light 1 is a dark twin that only lends its wide, coarse map. Each fragment reads
// the near map inside its frame and the far one beyond it, blending across the seam; light 1 itself is never shaded.
{
  const src = THREE.ShaderChunk.lights_fragment_begin;
  const a = src.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )'), b = src.indexOf('#endif', src.indexOf('#pragma unroll_loop_end', a)) + 6;
  if (a < 0 || b < 6) throw new Error('three lights chunk changed: update sky.js');
  THREE.ShaderChunk.lights_fragment_begin = src.slice(0, a) + /* glsl */`
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )
	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	#endif
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS == 3
	#define HF_AO_SET
	float hfAO = 1.;
	if ( receiveShadow ) hfAO = heightAO( directionalShadowMap[ 2 ], vDirectionalShadowCoord[ 2 ], ( vec4( geometryNormal, 0. ) * viewMatrix ).xyz );
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
		#if ! ( NUM_DIR_LIGHT_SHADOWS >= 2 && UNROLLED_LOOP_INDEX >= 1 )
		directionalLight = directionalLights[ i ];
		getDirectionalLightInfo( directionalLight, directLight );
		#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS >= 2 && UNROLLED_LOOP_INDEX == 0
		if ( directLight.visible && receiveShadow ) {
			vec4 c0 = vDirectionalShadowCoord[ 0 ], c1 = vDirectionalShadowCoord[ 1 ];
			vec3 p0 = c0.xyz / c0.w, p1 = c1.xyz / c1.w;
			vec2 e0 = min( p0.xy, 1. - p0.xy ), e1 = min( p1.xy, 1. - p1.xy );
			float w = p0.z < 1. ? smoothstep( 0., .1, min( e0.x, e0.y ) ) : 0.;
			float s0 = 1., s1 = 1.;
			if ( w > 0. ) s0 = getShadow( directionalShadowMap[ 0 ], directionalLightShadows[ 0 ].shadowMapSize, directionalLightShadows[ 0 ].shadowIntensity, directionalLightShadows[ 0 ].shadowBias, directionalLightShadows[ 0 ].shadowRadius, c0 );
			if ( w < 1. ) { s1 = getShadow( directionalShadowMap[ 1 ], directionalLightShadows[ 1 ].shadowMapSize, directionalLightShadows[ 1 ].shadowIntensity, directionalLightShadows[ 1 ].shadowBias, directionalLightShadows[ 1 ].shadowRadius, c1 );
				s1 = mix( 1., s1, smoothstep( 0., .06, min( e1.x, e1.y ) ) ); }
			directLight.color *= mix( s1, s0, w );
			#if NUM_DIR_LIGHT_SHADOWS == 3
			directLight.color *= cloudShadow( geometryPosition );
			#endif
		}
		#elif defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		directionalLightShadow = directionalLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
		#endif
	}
	#pragma unroll_loop_end
#endif` + src.slice(b);
}

// ─── CPU side: the sun's transmittance (same air, same numbers) ─────────────────────────────────────────────────────────
function transmittance(sunY, alt, out) {
  const ry = RE + alt, cy = Math.max(-1, Math.min(1, sunY)), sx = Math.sqrt(1 - cy * cy);
  // behind the planet? (ray from (0, ry) towards (sx, cy))
  const b = ry * cy, c = ry * ry - RE * RE, dg = b * b - c;
  if (dg >= 0 && -b - Math.sqrt(dg) > 0) return out.setRGB(0, 0, 0);
  const cA = ry * ry - RA * RA, tm = -b + Math.sqrt(b * b - cA), N = 48, dt = tm / N;
  let r = 0, g = 0, bl = 0;
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) * dt, x = sx * t, y = ry + cy * t, h = Math.hypot(x, y) - RE;
    const dr = Math.exp(-h / HR), dm = Math.exp(-h / HM) * HAZE, dz = Math.max(0, 1 - Math.abs(h - 25000) / 15000);
    const m = (BM + AM) * dm;
    r += (BR[0] * dr + m + OZ[0] * dz) * dt; g += (BR[1] * dr + m + OZ[1] * dz) * dt; bl += (BR[2] * dr + m + OZ[2] * dz) * dt;
  }
  return out.setRGB(Math.exp(-r), Math.exp(-g), Math.exp(-bl));
}

// ─── ambient occlusion from a height map ───────────────────────────────────────────────────────────────────────────────
// A third (black) directional light looks straight down and lends its depth map: the city's height field around the view,
// redrawn rarely. Each lit fragment compares its own height with the heights a few metres around it (pushed out along its
// normal), so street canyons, courtyards and the foot of every wall darken in the sky light, where real occlusion lives.
// 4 taps on phones, 8 elsewhere; the occluding heights are exact (depth is linear in an orthographic map).
export const AO = { range: 1000 };
function installAO(mobile) {
  const R = mobile ? 900 : 1300, N = mobile ? 4 : 8;
  AO.R = R; AO.size = mobile ? 1024 : 2048;
  THREE.ShaderChunk.shadowmap_pars_fragment += /* glsl */`
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS == 3
// cloud shadows: the sky's own cloud deck (same noise, same drift, see DOME_FRAG), followed from each fragment up the sun ray.
// The deck's cover and drift ride in the colour of light 1 (a twin that is never shaded): no extra uniforms on any material.
float csH( vec2 p ) { vec3 q = fract( vec3( p.xyx ) * .1031 ); q += dot( q, q.yzx + 33.33 ); return fract( ( q.x + q.y ) * q.z ); }
float csN( vec2 p ) { vec2 i = floor( p ), f = fract( p ); f = f * f * ( 3. - 2. * f );
  return mix( mix( csH( i ), csH( i + vec2( 1, 0 ) ), f.x ), mix( csH( i + vec2( 0, 1 ) ), csH( i + vec2( 1, 1 ) ), f.x ), f.y ); }
float cloudShadow( vec3 posV ) {
  vec3 cd = directionalLights[ 1 ].color;   // ( cover, drift x, drift z )
  if ( cd.x <= 0. ) return 1.;
  vec3 L = ( vec4( directionalLights[ 0 ].direction, 0. ) * viewMatrix ).xyz;
  if ( L.y < .03 ) return 1.;
  vec3 wp = cameraPosition + ( vec4( posV, 0. ) * viewMatrix ).xyz;
  vec2 q = ( wp.xz + L.xz * ( 1800. - wp.y ) / L.y ) / 2600. + cd.yz;
  float n = csN( q ) * .5 + csN( q * 2.03 + 1.7 ) * .25 + ${mobile ? '.09' : 'csN( q * 4.1 + 3.1 ) * .125 + .03'};
  return 1. - .86 * smoothstep( 1. - cd.x, 1.15 - cd.x * .7, n );
}
float heightAO( sampler2D map, vec4 c, vec3 nw ) {
  vec3 p = c.xyz / c.w; vec2 e = min( p.xy, 1. - p.xy ); float edge = smoothstep( 0., .04, min( e.x, e.y ) );
  if ( edge <= 0. ) return 1.;
  vec2 n = nw.xz * ( 1. - abs( nw.y ) );   // walls look out along their normal; roofs and ground look all round
  float sum = 0.;
  for ( int k = 0; k < ${N}; k ++ ) {
    float a = float( k ) * ${(Math.PI * 2 / N).toFixed(5)} + .4, r = k % 2 == 0 ? 4. : 11.;
    vec2 o = vec2( cos( a ), sin( a ) ) * r + n * r * .9;
    float zm = unpackRGBAToDepth( texture2D( map, p.xy + vec2( o.x, - o.y ) * ${(1 / (2 * R)).toExponential(5)} ) );
    sum += clamp( ( p.z - zm ) * ${AO.range.toFixed(1)} / r - .1, 0., 1. );   // occluder rise over distance: 45° and up is fully dark
  }
  return 1. - .7 * edge * sum / ${N}.;
}
#endif`;
  THREE.ShaderChunk.aomap_fragment += /* glsl */`
#ifdef HF_AO_SET
reflectedLight.indirectDiffuse *= hfAO;
reflectedLight.indirectSpecular *= mix( 1., hfAO, .6 );
reflectedLight.directDiffuse *= mix( 1., hfAO, .15 );   // a little contact darkness in the sun too (the light that would have bounced)
#endif`;
}

export function createSky(renderer, scene, { mobile = false } = {}) {
  installAO(mobile);
  const halfOK = renderer.capabilities.isWebGL2 && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'));
  const lut = new THREE.WebGLRenderTarget(128, 64, { type: halfOK ? THREE.HalfFloatType : THREE.UnsignedByteType, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });
  const sunU = { value: new THREE.Vector3(0, 1, 0) }, mie = { value: HAZE };
  const lutMat = new THREE.ShaderMaterial({ uniforms: { uSun: sunU, uMie: mie }, vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }', fragmentShader: halfOK ? LUT_FRAG : LUT_FRAG.replace('gl_FragColor = vec4(L, 1.);', 'gl_FragColor = vec4(L / (1. + L), 1.);'), depthTest: false, depthWrite: false });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), lutMat); quad.frustumCulled = false;
  const qScene = new THREE.Scene(); qScene.add(quad);
  const qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const common = { uLut: { value: lut.texture }, uSunW: { value: new THREE.Vector3(0, 1, 0) }, uSunE: { value: 4 }, uNightSky: { value: new THREE.Vector3() }, uGlow: { value: new THREE.Vector3() } };
  const decode = halfOK ? '' : '#define LUT8\n';
  const fixLut = (s) => (halfOK ? s : s.replace('vec3 L = texture2D(uLut,', 'vec3 L8 = texture2D(uLut,').replace('.rgb * uSunE;', '.rgb; vec3 L = L8 / max(vec3(1e-4), 1. - L8) * uSunE;'));
  const dome = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
    uniforms: { ...common, uInvVP: { value: new THREE.Matrix4() }, uSunDisc: { value: new THREE.Color() }, uSunCloud: { value: new THREE.Color() }, uAmbCloud: { value: new THREE.Color() },
      uCover: { value: 0.32 }, uTime: { value: 0 }, uStars: { value: 0 }, uCloudGlow: { value: 0 } },
    vertexShader: DOME_VERT, fragmentShader: decode + (mobile ? '#define SKY_LITE\n' : '') + fixLut(DOME_FRAG), depthWrite: false, depthTest: true, depthFunc: THREE.LessEqualDepth,
  }));
  dome.geometry.setDrawRange(0, 3); dome.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  dome.frustumCulled = false; dome.renderOrder = 1e6; dome.name = 'sky'; dome.userData.farMerged = true;   // (walkers skip it)
  const _vp = new THREE.Matrix4();
  dome.onBeforeRender = (r, s, cam) => { _vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).invert(); dome.material.uniforms.uInvVP.value.copy(_vp); };
  scene.add(dome);

  // environment: the same sky without sun or clouds, baked into a PMREM
  const envMat = new THREE.ShaderMaterial({ uniforms: { ...common, uGround: { value: new THREE.Color() } }, side: THREE.BackSide, depthWrite: false,
    vertexShader: 'varying vec3 vW; void main(){ vW = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }', fragmentShader: decode + fixLut(ENV_FRAG) });
  const envScene = new THREE.Scene(); envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 48, 24), envMat));
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envRT = null;

  const T = new THREE.Color(), Tc = new THREE.Color(), sunCol = new THREE.Color();
  const state = { sunE: 4, sunColor: new THREE.Color(), night: 0, exposure: 1 };
  let lastKey = '';
  function update(sunDir, { night = 0 } = {}) {
    sunU.value.copy(sunDir); common.uSunW.value.copy(sunDir);
    const E0 = 4.3;   // sun irradiance above the air, in scene units (≈3.5 at the ground with a high sun)
    common.uSunE.value = E0;
    transmittance(sunDir.y, CAM_ALT, T);
    transmittance(sunDir.y, 1800, Tc);
    // horizon fade: the disc slips under the hills over its last half degree
    const sunVis = THREE.MathUtils.smoothstep(sunDir.y, -0.012, 0.006);
    sunCol.copy(T).multiplyScalar(E0 * sunVis);
    state.sunColor.copy(sunCol); state.night = night;
    const u = dome.material.uniforms;
    u.uSunDisc.value.copy(T).multiplyScalar(E0 * sunVis);
    u.uSunCloud.value.copy(Tc).multiplyScalar(E0);
    const day = THREE.MathUtils.smoothstep(sunDir.y, -0.12, 0.25);
    u.uAmbCloud.value.setRGB(0.55, 0.62, 0.75).multiplyScalar(0.35 * day + 0.004).lerp(Tc.clone().multiplyScalar(0.3 * day), 0.25);
    u.uStars.value = THREE.MathUtils.smoothstep(night, 0.6, 1);
    u.uCloudGlow.value = night * 3;
    common.uNightSky.value.set(0.012, 0.02, 0.045).multiplyScalar(night);
    common.uGlow.value.set(0.018, 0.010, 0.0045).multiplyScalar(night);   // sodium light pollution on the haze
    // ground bounce for the environment's lower half: grey-brown city, lit by the sun and the sky
    envMat.uniforms.uGround.value.setRGB(0.2, 0.18, 0.15).multiplyScalar((sunCol.r + sunCol.g + sunCol.b) / 3 * Math.max(0, sunDir.y) / Math.PI + 0.55 * day + 0.01 * night);

    const key = `${sunDir.x.toFixed(3)},${sunDir.y.toFixed(3)},${sunDir.z.toFixed(3)},${night.toFixed(2)}`;
    if (key === lastKey) return state;
    lastKey = key;
    const prev = renderer.getRenderTarget(), tm = renderer.toneMapping;
    renderer.setRenderTarget(lut); renderer.render(qScene, qCam); renderer.setRenderTarget(prev);
    renderer.toneMapping = THREE.NoToneMapping;
    const rt = pmrem.fromScene(envScene, 0, 0.1, 1000);
    renderer.toneMapping = tm;
    envRT?.dispose(); envRT = rt; scene.environment = rt.texture;
    return state;
  }
  return { update, dome, state, set clouds(v) { dome.material.uniforms.uCover.value = v; }, tick(t) { dome.material.uniforms.uTime.value = t; } };
}
