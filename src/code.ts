// Prints the IR as shader code. One printer, three dialects: GLSL (three.js and RICO), Godot's shading language,
// and HLSL (Unreal's Custom node, Unity's Custom Function). Every target gets the same maths, so they match.
import { type Arg, type IR, type Lit, type Step, type Type, rampStops } from './spec.ts'

export type Dialect = 'glsl' | 'godot' | 'hlsl'

export interface Lang {
  d: Dialect
  vec3: string
  ty: (t: Type) => string
  splat: (x: string) => string
  v3: (x: string, y: string, z: string) => string
  mix: string
  fract: string
}

export const LANG: Record<Dialect, Lang> = {
  glsl: { d: 'glsl', vec3: 'vec3', ty: (t) => (t === 'vec3' ? 'vec3' : 'float'), splat: (x) => `vec3(${x})`, v3: (x, y, z) => `vec3(${x}, ${y}, ${z})`, mix: 'mix', fract: 'fract' },
  godot: { d: 'godot', vec3: 'vec3', ty: (t) => (t === 'vec3' ? 'vec3' : 'float'), splat: (x) => `vec3(${x})`, v3: (x, y, z) => `vec3(${x}, ${y}, ${z})`, mix: 'mix', fract: 'fract' },
  hlsl: { d: 'hlsl', vec3: 'float3', ty: (t) => (t === 'vec3' ? 'float3' : 'float'), splat: (x) => `((float3)(${x}))`, v3: (x, y, z) => `float3(${x}, ${y}, ${z})`, mix: 'lerp', fract: 'frac' },
}

export const num = (x: number) => {
  if (!Number.isFinite(x)) return '0.0'
  const s = String(Math.fround(x) === x ? x : x)
  return /[.e]/.test(s) ? s : s + '.0'
}
const lit = (L: Lang, v: Lit, t: Type) => (typeof v === 'number' ? (t === 'vec3' ? L.splat(num(v)) : num(v)) : L.v3(num(v[0]), num(v[1]), num(v[2])))
export const argStr = (L: Lang, a: Arg) => (a.k === 'lit' ? lit(L, a.v, a.type) : a.id)

// Helper functions, written once in GLSL-style and translated word by word. Every name starts with inoscula_.
// The noise is a port of Blender's Perlin noise and fBM (Cycles, Apache 2.0), including its integer hash, so the
// pattern is the same in every engine to within float rounding.
const HELPERS_GLSL = `
float inoscula_div_f(float a, float b) { return b == 0.0 ? 0.0 : a / b; }
vec3 inoscula_div_v(vec3 a, vec3 b) { return vec3(inoscula_div_f(a.x, b.x), inoscula_div_f(a.y, b.y), inoscula_div_f(a.z, b.z)); }
float inoscula_pow_f(float a, float b) {
  if (a >= 0.0) return pow(a, b);
  if (b != floor(b)) return 0.0;
  float r = pow(-a, b);
  return (floor(b * 0.5) * 2.0 == b) ? r : -r;
}
vec3 inoscula_pow_v(vec3 a, vec3 b) { return vec3(inoscula_pow_f(a.x, b.x), inoscula_pow_f(a.y, b.y), inoscula_pow_f(a.z, b.z)); }
vec3 inoscula_normalize(vec3 v) { float l = length(v); return l == 0.0 ? vec3(0.0) : v / l; }
float inoscula_has_shape(vec3 c) { return abs(c.z - 0.5) < 0.3 ? 1.0 : 0.0; }
float inoscula_sqrt_f(float x) { return x > 0.0 ? sqrt(x) : 0.0; }
vec3 inoscula_sqrt_v(vec3 v) { return vec3(inoscula_sqrt_f(v.x), inoscula_sqrt_f(v.y), inoscula_sqrt_f(v.z)); }
`
const HASH_GLSL = `
uint inoscula_rot(uint x, uint k) { return (x << k) | (x >> (32u - k)); }
uint inoscula_hash3(uint kx, uint ky, uint kz) {
  uint a = 0xdeadbeefu + 25u;
  uint b = a;
  uint c = a;
  c = c + kz; b = b + ky; a = a + kx;
  c = c ^ b; c = c - inoscula_rot(b, 14u);
  a = a ^ c; a = a - inoscula_rot(c, 11u);
  b = b ^ a; b = b - inoscula_rot(a, 25u);
  c = c ^ b; c = c - inoscula_rot(b, 16u);
  a = a ^ c; a = a - inoscula_rot(c, 4u);
  b = b ^ a; b = b - inoscula_rot(a, 14u);
  c = c ^ b; c = c - inoscula_rot(b, 24u);
  return c;
}
float inoscula_white(vec3 p) { return float(inoscula_hash3(floatBitsToUint(p.x), floatBitsToUint(p.y), floatBitsToUint(p.z))) * 2.3283064365386963e-10; }
`
// Voronoi, ported from Cycles (F1, Euclidean, one octave). Blender places its cell points with the PCG3D
// integer hash (signed, wrapping maths, arithmetic shift), reproduced here bit for bit.
const VORONOI_GLSL = `
vec3 inoscula_cellhash(int x, int y, int z) {
  int vx = x * 1664525 + 1013904223;
  int vy = y * 1664525 + 1013904223;
  int vz = z * 1664525 + 1013904223;
  vx = vx + vy * vz; vy = vy + vz * vx; vz = vz + vx * vy;
  vx = vx ^ (vx >> 16); vy = vy ^ (vy >> 16); vz = vz ^ (vz >> 16);
  vx = vx + vy * vz; vy = vy + vz * vx; vz = vz + vx * vy;
  return vec3(float(vx & 0x7FFFFFFF), float(vy & 0x7FFFFFFF), float(vz & 0x7FFFFFFF)) * 4.656612873077393e-10;
}
void inoscula_voronoi(vec3 p, float scale, float randomness, out float dist, out vec3 col, out vec3 pos) {
  vec3 coord = p * scale;
  vec3 cf = floor(coord);
  vec3 local = coord - cf;
  int cx = int(cf.x);
  int cy = int(cf.y);
  int cz = int(cf.z);
  float md = 3.4e38;
  int tx = 0;
  int ty = 0;
  int tz = 0;
  vec3 tp = vec3(0.0);
  for (int k = -1; k <= 1; k++) {
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec3 pp = vec3(float(i), float(j), float(k)) + inoscula_cellhash(cx + i, cy + j, cz + k) * randomness;
        float d = length(pp - local);
        if (d < md) { tx = i; ty = j; tz = k; md = d; tp = pp; }
      }
    }
  }
  dist = md;
  col = inoscula_cellhash(cx + tx, cy + ty, cz + tz);
  pos = inoscula_div_v(tp + cf, vec3(scale, scale, scale));
}
`
// Surface bumps from a height value, using screen derivatives (the same method as Blender's Bump node).
const BUMP_GLSL = `
vec3 inoscula_bump(vec3 sp, vec3 sn, float h) {
  vec3 sx = dFdx(sp);
  vec3 sy = dFdy(sp);
  vec3 r1 = cross(sy, sn);
  vec3 r2 = cross(sn, sx);
  float det = dot(sx, r1);
  vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  return normalize(abs(det) * sn - grad);
}
`
const NOISE_GLSL = `
float inoscula_grad3(uint hh, float x, float y, float z) {
  uint h = hh & 15u;
  float u = h < 8u ? x : y;
  float vt = (h == 12u || h == 14u) ? x : z;
  float v = h < 4u ? y : vt;
  return ((h & 1u) != 0u ? -u : u) + ((h & 2u) != 0u ? -v : v);
}
float inoscula_fade(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
float inoscula_perlin3(vec3 p) {
  vec3 fl = floor(p);
  vec3 f = p - fl;
  uint X = uint(int(fl.x));
  uint Y = uint(int(fl.y));
  uint Z = uint(int(fl.z));
  float u = inoscula_fade(f.x);
  float v = inoscula_fade(f.y);
  float w = inoscula_fade(f.z);
  float n0 = inoscula_grad3(inoscula_hash3(X, Y, Z), f.x, f.y, f.z);
  float n1 = inoscula_grad3(inoscula_hash3(X + 1u, Y, Z), f.x - 1.0, f.y, f.z);
  float n2 = inoscula_grad3(inoscula_hash3(X, Y + 1u, Z), f.x, f.y - 1.0, f.z);
  float n3 = inoscula_grad3(inoscula_hash3(X + 1u, Y + 1u, Z), f.x - 1.0, f.y - 1.0, f.z);
  float n4 = inoscula_grad3(inoscula_hash3(X, Y, Z + 1u), f.x, f.y, f.z - 1.0);
  float n5 = inoscula_grad3(inoscula_hash3(X + 1u, Y, Z + 1u), f.x - 1.0, f.y, f.z - 1.0);
  float n6 = inoscula_grad3(inoscula_hash3(X, Y + 1u, Z + 1u), f.x, f.y - 1.0, f.z - 1.0);
  float n7 = inoscula_grad3(inoscula_hash3(X + 1u, Y + 1u, Z + 1u), f.x - 1.0, f.y - 1.0, f.z - 1.0);
  float x1 = 1.0 - u;
  float y1 = 1.0 - v;
  float z1 = 1.0 - w;
  return z1 * (y1 * (n0 * x1 + n1 * u) + v * (n2 * x1 + n3 * u)) + w * (y1 * (n4 * x1 + n5 * u) + v * (n6 * x1 + n7 * u));
}
float inoscula_snoise3(vec3 p) { return 0.982 * inoscula_perlin3(p); }
float inoscula_noise(vec3 p, float scale, float detail, float roughness, float lacunarity) {
  p = p * scale;
  detail = clamp(detail, 0.0, 15.0);
  roughness = max(roughness, 0.0);
  float fscale = 1.0;
  float amp = 1.0;
  float maxamp = 0.0;
  float sum = 0.0;
  int n = int(detail);
  for (int i = 0; i <= 15; i++) {
    if (i > n) break;
    float t = inoscula_snoise3(fscale * p);
    sum += t * amp;
    maxamp += amp;
    amp *= roughness;
    fscale *= lacunarity;
  }
  float rmd = detail - floor(detail);
  if (rmd != 0.0) {
    float t = inoscula_snoise3(fscale * p);
    float sum2 = sum + t * amp;
    return mix(0.5 * sum / maxamp + 0.5, 0.5 * sum2 / (maxamp + amp) + 0.5, rmd);
  }
  return 0.5 * sum / maxamp + 0.5;
}
`

// GLSL lets vec3(x) fill all three parts from one number. HLSL compilers before DXC accepted float3(x) too, but
// DXC (Unreal 5 on SM6, newer Unity) rejects it, so every one-argument float2/3/4(...) is rewritten as a cast.
export function hlslSplats(src: string): string {
  const re = /\bfloat([234])\(/g
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let depth = 1
    let commas = 0
    let i = m.index + m[0].length
    for (; i < src.length && depth > 0; i++) {
      const c = src[i]
      if (c === '(') depth++
      else if (c === ')') depth--
      else if (c === ',' && depth === 1) commas++
    }
    if (depth !== 0) break
    const inner = src.slice(m.index + m[0].length, i - 1)
    if (commas === 0 && inner.trim() !== '') {
      out += src.slice(last, m.index) + `((float${m[1]})(${hlslSplats(inner)}))`
      last = i
      re.lastIndex = i
    }
  }
  return out + src.slice(last)
}

function translate(src: string, L: Lang) {
  if (L.d !== 'hlsl') return src
  return hlslSplats(src.replace(/\bdFdx\(/g, 'ddx(').replace(/\bdFdy\(/g, 'ddy(').replace(/\bfloatBitsToUint\(/g, 'asuint(').replace(/\bvec3\(0\.0\)/g, '((float3)0.0)').replace(/\bvec3\b/g, 'float3').replace(/\bmix\(/g, 'lerp(').replace(/\bfract\(/g, 'frac('))
}

// Blender does not evaluate a color ramp directly: it samples it into a 257 entry table (steps of 1/256) and reads that
// (stepping for Constant, blending neighbors for Linear). Doing the same here makes band edges land on exactly
// the same pixels as in Blender instead of up to 1/255 away.
function rampFn(L: Lang, s: Step) {
  const exact = rampExact(L, s)
  const linear = s.set.mode !== 'constant'
  return `${exact}
${L.vec3} inoscula_ramp_${s.id}(float t) {
  float f = clamp(t, 0.0, 1.0) * 256.0;
  float i = floor(f);
  ${L.vec3} c = inoscula_ramp_${s.id}_at(i / 256.0);
${linear ? `  float r = f - i;
  if (r > 0.0) c = ${L.mix}(c, inoscula_ramp_${s.id}_at((i + 1.0) / 256.0), r);
` : ''}  return c;
}`
}

function rampExact(L: Lang, s: Step) {
  const stops = rampStops(s.set)
  const c = (i: number) => L.v3(num(stops[i][1][0]), num(stops[i][1][1]), num(stops[i][1][2]))
  const lines = [`${L.vec3} inoscula_ramp_${s.id}_at(float t) {`]
  const last = stops.length - 1
  lines.push(`  if (t <= ${num(stops[0][0])}) return ${c(0)};`)
  lines.push(`  if (t >= ${num(stops[last][0])}) return ${c(last)};`)
  for (let i = 0; i < last; i++) {
    const [p0] = stops[i], [p1] = stops[i + 1]
    if (s.set.mode === 'constant' || p1 === p0) lines.push(`  if (t < ${num(p1)}) return ${c(i)};`)
    else lines.push(`  if (t < ${num(p1)}) return ${L.mix}(${c(i)}, ${c(i + 1)}, (t - ${num(p0)}) / ${num(p1 - p0)});`)
  }
  lines.push(`  return ${c(last)};`, '}')
  return lines.join('\n')
}

/** Just the noise (for the outline pass, which breaks its line up with the same noise everywhere). */
export function noiseHelpers(L: Lang) { return translate(HASH_GLSL + NOISE_GLSL, L) }

/** Helper functions this IR needs (noise only if used, one function per ramp). */
export function helpers(ir: IR, L: Lang) {
  let out = translate(HELPERS_GLSL, L)
  if (ir.uses.has('hash')) out += translate(HASH_GLSL, L)
  if (ir.uses.has('noise')) out += translate(NOISE_GLSL, L)
  if (ir.uses.has('voronoi')) out += translate(VORONOI_GLSL, L)
  if (ir.lit && ir.bump) out += translate(BUMP_GLSL, L)
  for (const s of ir.steps) if (s.op === 'ramp') out += rampFn(L, s) + '\n'
  return out
}

/** Names the targets must provide as variables before the body runs, all already in canonical space. */
export const SOURCE_VARS: Record<string, string> = {
  uv: 'g_uv', object_pos: 'g_obj', world_pos: 'g_wpos', normal: 'g_nrm', object_normal: 'g_onrm',
  view_dir: 'g_view', time: 'g_time', light_dir: 'g_light_dir', light_color: 'g_light_color',
  curvature: 'g_curv', occlusion: 'g_occ', object_size: 'g_osize',
}

/** The body: one line per step, ending with variables g_out_color and g_out_alpha. */
export function body(ir: IR, L: Lang, indent = '  ') {
  const out: string[] = []
  const A = (s: Step, i: number) => argStr(L, s.args[i])
  // a float handed to a vector helper is spread to all three parts first
  const stepType = new Map(ir.steps.map((x) => [x.id, x.type]))
  const realType = (a: Step['args'][number]) => {
    if (a.k !== 'ref') return a.type
    if (/_(x|y|z)$/.test(a.id)) return 'float'
    return stepType.get(a.id) ?? stepType.get(a.id.replace(/_(out|color|position)$/, '')) ?? ir.params.find((p) => 'p_' + p.id === a.id)?.t ?? a.type
  }
  const AV = (s: Step, i: number) => (s.type === 'vec3' && realType(s.args[i]) === 'float' ? L.splat(A(s, i)) : A(s, i))
  for (const s of ir.steps) {
    const t = L.ty(s.type)
    const v = s.type === 'vec3'
    let e: string
    switch (s.op) {
      case 'value': e = lit(L, s.set.v as Lit, s.type); break
      case 'add': e = `${A(s, 0)} + ${A(s, 1)}`; break
      case 'sub': e = `${A(s, 0)} - ${A(s, 1)}`; break
      case 'mul': e = `${A(s, 0)} * ${A(s, 1)}`; break
      case 'div': e = `inoscula_div_${v ? 'v' : 'f'}(${AV(s, 0)}, ${AV(s, 1)})`; break
      case 'pow': e = `inoscula_pow_${v ? 'v' : 'f'}(${AV(s, 0)}, ${AV(s, 1)})`; break
      case 'min': e = `min(${AV(s, 0)}, ${AV(s, 1)})`; break
      case 'max': e = `max(${AV(s, 0)}, ${AV(s, 1)})`; break
      case 'clamp': e = `min(max(${AV(s, 0)}, ${AV(s, 1)}), ${AV(s, 2)})`; break
      case 'abs': e = `abs(${A(s, 0)})`; break
      case 'floor': e = `floor(${A(s, 0)})`; break
      case 'fract': e = `${A(s, 0)} - floor(${A(s, 0)})`; break
      case 'sin': e = `sin(${A(s, 0)})`; break
      case 'cos': e = `cos(${A(s, 0)})`; break
      case 'exp': e = `exp(${A(s, 0)})`; break
      case 'log': e = `(${A(s, 0)} > 0.0 ? log(${A(s, 0)}) : 0.0)`; break
      case 'sqrt': e = `inoscula_sqrt_${v ? 'v' : 'f'}(${A(s, 0)})`; break
      case 'atan2': e = L.d === 'hlsl' ? `atan2(${A(s, 0)}, ${A(s, 1)})` : `atan(${A(s, 0)}, ${A(s, 1)})`; break
      case 'white_noise': e = `inoscula_white(${A(s, 0)})`; break
      case 'one_minus': e = `${v ? L.splat('1.0') : '1.0'} - ${A(s, 0)}`; break
      case 'mix': e = `${L.mix}(${AV(s, 0)}, ${AV(s, 1)}, clamp(${A(s, 2)}, 0.0, 1.0))`; break
      case 'smoothstep': e = `smoothstep(${A(s, 0)}, ${A(s, 1)}, ${A(s, 2)})`; break
      case 'greater': e = `(${A(s, 0)} > ${A(s, 1)} ? 1.0 : 0.0)`; break
      case 'dot': e = `dot(${A(s, 0)}, ${A(s, 1)})`; break
      case 'length': e = `length(${A(s, 0)})`; break
      case 'normalize': e = `inoscula_normalize(${A(s, 0)})`; break
      case 'combine': e = L.v3(A(s, 0), A(s, 1), A(s, 2)); break
      case 'separate':
        for (const c of ['x', 'y', 'z']) out.push(`${indent}float ${s.id}_${c} = ${A(s, 0)}.${c};`)
        continue
      case 'voronoi':
        out.push(`${indent}float ${s.id};`, `${indent}${L.vec3} ${s.id}_color;`, `${indent}${L.vec3} ${s.id}_position;`)
        out.push(`${indent}inoscula_voronoi(${A(s, 0)}, ${A(s, 1)}, ${A(s, 2)}, ${s.id}, ${s.id}_color, ${s.id}_position);`)
        continue
      case 'noise': e = `inoscula_noise(${[0, 1, 2, 3, 4].map((i) => A(s, i)).join(', ')})`; break
      case 'ramp': e = `inoscula_ramp_${s.id}(${A(s, 0)})`; break
      default: {
        const src = SOURCE_VARS[s.op]
        if (!src) throw new Error(`no code for ${s.op}`)
        e = src
      }
    }
    out.push(`${indent}${t} ${s.id} = ${e};`)
  }
  out.push(`${indent}${L.vec3} g_out_color = ${argStr(L, ir.color)};`)
  out.push(`${indent}float g_out_alpha = ${ir.alpha ? argStr(L, ir.alpha) : '1.0'};`)
  out.push(`${indent}float g_out_rough = ${argStr(L, ir.roughness)};`)
  out.push(`${indent}float g_out_metal = ${argStr(L, ir.metallic)};`)
  out.push(`${indent}float g_out_bump = ${ir.bump ? argStr(L, ir.bump) : '0.0'};`)
  out.push(`${indent}${L.vec3} g_out_emit = ${ir.emission ? argStr(L, ir.emission) : L.splat('0.0')};`)
  const ly = ir.layers
  out.push(`${indent}float g_out_coat = ${ly?.coat ? argStr(L, ly.coat) : '0.0'};`)
  out.push(`${indent}float g_out_coat_rough = ${ly?.coat_roughness ? argStr(L, ly.coat_roughness) : '0.03'};`)
  out.push(`${indent}float g_out_sheen = ${ly?.sheen ? argStr(L, ly.sheen) : '0.0'};`)
  out.push(`${indent}${L.vec3} g_out_sheen_color = ${ly?.sheen_color ? argStr(L, ly.sheen_color) : L.splat('1.0')};`)
  out.push(`${indent}float g_out_sheen_rough = ${ly?.sheen_roughness ? argStr(L, ly.sheen_roughness) : '0.5'};`)
  out.push(`${indent}float g_out_sss = ${ly?.subsurface ? argStr(L, ly.subsurface) : '0.0'};`)
  if (ir.glass) {
    out.push(`${indent}float g_out_glass = clamp(${argStr(L, ir.glass.amount)}, 0.0, 1.0);`)
    out.push(`${indent}float g_out_ior = ${argStr(L, ir.glass.ior)};`)
    out.push(`${indent}float g_out_disp = ${argStr(L, ir.glass.dispersion)};`)
  }
  return out.join('\n')
}

/** The helper functions one at a time, for code nodes that each carry only what they call. */
export function helperParts(L: Lang) {
  return { base: translate(HELPERS_GLSL, L), hash: translate(HASH_GLSL, L), noise: translate(NOISE_GLSL, L), voronoi: translate(VORONOI_GLSL, L), bump: translate(BUMP_GLSL, L), ramp: (s: Step) => rampFn(L, s) }
}
