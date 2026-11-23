// GLSL for the star map. Colors arrive as linear THREE.Color uniforms and are
// written in linear HDR; values above 1.0 are what the bloom pass picks up.

export const fullscreenVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

// Rendered once per resize into a half-float target: gradient, nebula and the milky band.
export const skyFragment = /* glsl */ `
uniform vec2 uResolution;
uniform vec3 uTop;
uniform vec3 uMid;
uniform vec3 uBottom;
uniform vec3 uNebula;
uniform vec3 uBand;
uniform vec3 uBandWarm;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float value = 0.0, amplitude = 0.5;
  mat2 turn = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 6; i++) { value += amplitude * noise(p); p = turn * p; amplitude *= 0.5; }
  return value;
}

void main() {
  vec2 uv = vUv;
  vec2 p = vec2(uv.x * uResolution.x / uResolution.y, uv.y);
  vec3 color = mix(uBottom, uMid, smoothstep(0.0, 0.5, uv.y));
  color = mix(color, uTop, smoothstep(0.5, 1.0, uv.y));

  // Domain-warped fBm: a faint indigo veil, strongest away from the centre.
  vec2 warp = vec2(fbm(p * 1.4 + 3.1), fbm(p * 1.4 + vec2(5.2, 1.3)));
  float veil = fbm(p * 2.1 + 2.2 * warp);
  color += uNebula * smoothstep(0.42, 0.92, veil) * (0.55 + 0.45 * distance(uv, vec2(0.45, 0.5)));

  // Milky band rising from the bottom centre to the right edge.
  float offset = uv.y - (0.02 + 0.62 * (uv.x - 0.42));
  float band = exp(-offset * offset / 0.0065) * smoothstep(0.3, 0.62, uv.x);
  float clumps = fbm(p * 6.5 + warp * 1.7);
  float lanes = smoothstep(0.35, 0.75, fbm(p * 11.0 - warp));
  color += uBand * band * (0.25 + 1.1 * clumps) * (0.65 + 0.35 * lanes);
  color += uBandWarm * band * smoothstep(0.62, 0.9, clumps) * 0.6;

  // A second, fainter haze along the upper right.
  float upper = uv.y - (0.66 + 0.18 * (uv.x - 0.7));
  color += uBand * 0.22 * exp(-upper * upper / 0.004) * smoothstep(0.6, 0.95, uv.x) * fbm(p * 4.0);

  gl_FragColor = vec4(color, 1.0);
}
`

export const skyCopyFragment = /* glsl */ `
uniform sampler2D uSky;
uniform vec2 uShift;
varying vec2 vUv;
void main() {
  vec2 uv = (vUv - 0.5) / 1.04 + 0.5 + uShift;
  gl_FragColor = texture2D(uSky, uv);
}
`

export const dustVertex = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
attribute float aPhase;
uniform float uTime;
uniform float uPixelRatio;
uniform float uTwinkle;
varying vec3 vColor;
void main() {
  vec4 view = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * view;
  gl_PointSize = aSize * uPixelRatio;
  float speed = 0.5 + fract(aPhase * 7.13) * 1.9;
  vColor = aColor * (1.0 + uTwinkle * sin(uTime * speed + aPhase * 6.2831));
}
`

export const dustFragment = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float falloff = exp(-dot(d, d) * 22.0);
  if (falloff < 0.01) discard;
  gl_FragColor = vec4(vColor * falloff, 1.0);
}
`

// Camera-facing quad, sized in world units.
export const billboardVertex = /* glsl */ `
uniform float uScale;
varying vec2 vUv;
void main() {
  vUv = uv * 2.0 - 1.0;
  vec4 view = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  view.xy += position.xy * uScale;
  gl_Position = projectionMatrix * view;
}
`

// Topic star: white-hot core, 1/r² halo and diffraction spikes.
export const starFragment = /* glsl */ `
uniform vec3 uCore;
uniform vec3 uHalo;
uniform float uIntensity;
uniform float uSpike;
uniform float uTime;
uniform float uPhase;
varying vec2 vUv;
void main() {
  vec2 p = vUv;
  float r2 = dot(p, p);
  float core = exp(-r2 * 1400.0) * 9.0 + exp(-r2 * 260.0) * 1.6;
  float halo = 0.0042 / (r2 + 0.0042) * 0.75 + exp(-r2 * 14.0) * 0.18;
  float main = exp(-abs(p.y) * 260.0) * exp(-abs(p.x) * 3.4) + exp(-abs(p.x) * 260.0) * exp(-abs(p.y) * 3.4);
  vec2 q = mat2(0.7071, -0.7071, 0.7071, 0.7071) * p;
  float diagonal = (exp(-abs(q.y) * 320.0) * exp(-abs(q.x) * 8.0) + exp(-abs(q.x) * 320.0) * exp(-abs(q.y) * 8.0)) * 0.5;
  float twinkle = 1.0 + 0.05 * sin(uTime * 1.7 + uPhase) + 0.035 * sin(uTime * 3.3 + uPhase * 2.1);
  vec3 color = uCore * core + uHalo * halo + mix(uHalo, uCore, 0.55) * (main + diagonal) * uSpike * 2.2;
  float edge = smoothstep(1.0, 0.72, sqrt(r2));
  gl_FragColor = vec4(color * uIntensity * twinkle * edge, 1.0);
}
`

// Out-of-focus foreground light: a soft disc with a faint brighter rim.
export const bokehFragment = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uTime;
uniform float uPhase;
varying vec2 vUv;
void main() {
  float r = length(vUv);
  float disc = smoothstep(1.0, 0.55, r);
  float rim = smoothstep(0.55, 0.9, r) * smoothstep(1.0, 0.85, r) * 0.25;
  float breathe = 0.85 + 0.15 * sin(uTime * 0.35 + uPhase);
  gl_FragColor = vec4(uColor * (disc * 0.55 + rim) * uOpacity * breathe, 1.0);
}
`

// Screen-space ribbon: constant pixel width regardless of depth, soft edges,
// a white-to-blue gradient along the link and an optional travelling pulse.
export const ribbonVertex = /* glsl */ `
attribute vec3 aNext;
attribute float aSide;
attribute float aU;
uniform vec2 uResolution;
uniform float uWidth;
varying float vU;
varying float vSide;
void main() {
  vec4 a = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vec4 b = projectionMatrix * modelViewMatrix * vec4(aNext, 1.0);
  vec2 sa = a.xy / a.w * uResolution * 0.5;
  vec2 sb = b.xy / b.w * uResolution * 0.5;
  vec2 dir = normalize(sb - sa + vec2(1e-6, 0.0));
  vec2 normal = vec2(-dir.y, dir.x);
  a.xy += normal * aSide * uWidth / uResolution * a.w;
  gl_Position = a;
  vU = aU;
  vSide = aSide;
}
`

export const ribbonFragment = /* glsl */ `
uniform vec3 uEnd;
uniform vec3 uMid;
uniform float uIntensity;
uniform float uOpacity;
uniform float uDash;
uniform float uPulse;
uniform float uTime;
uniform float uFade;
uniform float uFadeSpan;
varying float vU;
varying float vSide;
void main() {
  float across = exp(-vSide * vSide * 5.0) - 0.0067;
  float middle = smoothstep(0.0, 0.5, vU) * smoothstep(1.0, 0.5, vU);
  vec3 color = mix(uEnd, uMid, pow(middle, 0.6));
  float dash = uDash > 0.0 ? smoothstep(0.35, 0.5, fract(vU * uDash)) * smoothstep(1.0, 0.85, fract(vU * uDash)) : 1.0;
  float ends = smoothstep(0.0, 0.03, vU) * smoothstep(1.0, 0.97, vU);
  float head = fract(uTime * 0.11);
  float pulse = uPulse * exp(-pow((vU - head) * 16.0, 2.0)) * 3.0;
  // A leaving thread becomes a short ray that points towards the other nebula.
  float fade = uFade > 0.0 ? smoothstep(uFadeSpan, 0.0, vU) : uFade < 0.0 ? smoothstep(1.0 - uFadeSpan, 1.0, vU) : 1.0;
  gl_FragColor = vec4(color * (uIntensity + pulse) * max(across, 0.0) * dash * ends * fade * uOpacity, 1.0);
}
`

// A topic nebula: slowly drifting domain-warped noise, tinted, fading to nothing at the edge.
export const nebulaFragment = /* glsl */ `
uniform vec3 uTint;
uniform vec3 uCoreTint;
uniform float uIntensity;
uniform float uTime;
uniform float uSeed;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float value = 0.0, amplitude = 0.5;
  mat2 turn = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { value += amplitude * noise(p); p = turn * p; amplitude *= 0.5; }
  return value;
}

void main() {
  vec2 p = vUv;
  float r = length(p);
  float falloff = smoothstep(1.0, 0.05, r);
  falloff *= falloff;
  vec2 q = p * 1.7 + vec2(uSeed * 3.1, uSeed * 1.7);
  vec2 warp = vec2(fbm(q + uTime * 0.012), fbm(q + vec2(4.3, 1.9) - uTime * 0.009));
  float gas = fbm(q * 1.3 + warp * 1.6);
  float filaments = smoothstep(0.52, 0.9, fbm(q * 3.1 - warp));
  float lanes = smoothstep(0.35, 0.7, fbm(q * 2.3 + warp * 2.0 + 7.0));
  float cloud = smoothstep(0.4, 0.95, gas) * falloff * (0.45 + 0.55 * lanes);
  float core = exp(-r * r * 9.0);
  vec3 color = uTint * (cloud * 0.9 + filaments * falloff * 0.35) + uCoreTint * core * 0.45;
  gl_FragColor = vec4(color * uIntensity, 1.0);
}
`

// A camera-facing quad that can be stretched and turned, so nebula layers are not round puffs.
export const nebulaVertex = /* glsl */ `
uniform float uScale;
uniform vec2 uStretch;
uniform float uTurn;
varying vec2 vUv;
void main() {
  vUv = uv * 2.0 - 1.0;
  vec2 p = position.xy * uStretch;
  float c = cos(uTurn), s = sin(uTurn);
  p = mat2(c, s, -s, c) * p;
  vec4 view = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  view.xy += p * uScale;
  gl_Position = projectionMatrix * view;
}
`

// Bakes one nebula layer into a texture once; uv spans -1..1 like a billboard.
export const bakeVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv * 2.0 - 1.0;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

// Draws a baked nebula layer: cheap texture read, slowly turning, tinted by intensity.
export const nebulaTextureFragment = /* glsl */ `
uniform sampler2D uMap;
uniform float uIntensity;
varying vec2 vUv;
void main() {
  vec3 color = texture2D(uMap, vUv * 0.5 + 0.5).rgb;
  gl_FragColor = vec4(color * uIntensity, 1.0);
}
`
