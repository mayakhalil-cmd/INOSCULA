// Any fragment shader written in GLSL to an Inoscula graph: Shadertoy (mainImage), The Book of Shaders and
// glslCanvas (u_time, gl_FragColor), GLSL Sandbox (time, resolution), three.js ShaderMaterial (vUv),
// TouchDesigner GLSL TOP (vUV, TDOutputSwizzle), ISF (TIME, RENDERSIZE) and plain GLSL with "out vec4".
//
// The picture is mapped onto the model's UVs: (0, 0) bottom left to (1, 1) top right, as a square image of
// RESOLUTION pixels a side, so code that measures in pixels (fragCoord, gl_FragCoord) still fits.
import { OPS, safeId, type Graph, type Param, type Wire } from '../spec.ts'
import { CodeError, lineMap } from '../lang.ts'
import { preprocess, numValue } from './pre.ts'
import { parseProgram, type Expr, type Fn, type Stmt } from './parse.ts'
import { Eval, type Val, type Var } from './eval.ts'
import { key, type S } from './build.ts'
import { F, I, vec, size, show, type Ty } from './types.ts'

export const RESOLUTION = 1024
export type Style = 'shadertoy' | 'book' | 'sandbox' | 'three' | 'touchdesigner' | 'isf' | 'glsl' | 'hlsl' | 'unity' | 'unreal'
export interface ReadResult { graph: Graph; style: Style; warnings: { line: number; msg: string }[] }

const STYLE_NAME: Record<Style, string> = {
  shadertoy: 'Shadertoy', book: 'The Book of Shaders', sandbox: 'GLSL Sandbox', three: 'three.js',
  touchdesigner: 'TouchDesigner', isf: 'ISF', glsl: 'GLSL', hlsl: 'HLSL', unity: 'Unity', unreal: 'Unreal Custom node',
}
export const styleName = (s: Style) => STYLE_NAME[s]

/** Does this text look like GLSL rather than Inoscula code? */
export function looksLikeGLSL(src: string): boolean {
  return /\bmainImage\s*\(|\bgl_Frag(Color|Coord)\b|#version\b|\bprecision\s+(high|medium|low)p\b|\bout\s+vec4\b|\b(iTime|iResolution|u_time|u_resolution|vUv|vUV|TDOutputSwizzle|RENDERSIZE|isf_FragNormCoord)\b|\b(vec2|vec4|ivec\d|mat[234]|int)\b|\bfor\s*\(|\bwhile\s*\(|\bif\s*\(|#define\b/.test(src)
}

// Inoscula outputs a shader may set directly, as in Inoscula code
const SURFACE_OUTS: Record<string, number> = { color: 3, alpha: 1, roughness: 1, metallic: 1, emission: 3, bump: 1, coat: 1, coat_roughness: 1, sheen: 1, sheen_color: 3, sheen_roughness: 1, subsurface: 1 }
const LIT = ['roughness', 'metallic', 'bump', 'emission', 'coat', 'coat_roughness', 'sheen', 'sheen_color', 'sheen_roughness', 'subsurface']

const TIME = ['iTime', 'iGlobalTime', 'u_time', 'uTime', 'time', 'TIME', 'utime', 'u_Time', 'iTime0', 'Time', 'gTime', 'g_Time', 'g_time', 'fTime', 'fGlobalTime']
const RES = ['iResolution', 'u_resolution', 'uResolution', 'resolution', 'Resolution', 'gResolution', 'g_Resolution', 'g_resolution', 'RENDERSIZE', 'u_Resolution', 'iRes', 'ScreenSize', 'screenSize']
const MOUSE = ['iMouse', 'u_mouse', 'uMouse', 'mouse', 'u_Mouse']
const UV_NAMES = /^(v_?uv|v_?texcoord\d?|vtexcoord|texcoord\d?|tex_?coord|uv\d?|isf_fragnormcoord|frag_?uv|vuv0|v_tex)$/i
const NORMAL_NAMES = /^(v_?normal|v_?worldnormal|normal_?ws|v_?norm|fnormal)$/i
const POS_NAMES = /^(v_?position|v_?pos|v_?localposition|v_?objectposition|fpos|fposition)$/i
const WPOS_NAMES = /^(v_?worldpos(ition)?|world_?pos(ition)?|v_?wpos)$/i
// a uniform with no value set: these names usually mean "1 is normal"
const ONE_NAMES = /speed|scale|zoom|intensity|strength|brightness|amount|size|density|freq|amp|contrast|saturation|gain|opacity|exposure|multiplier|factor|power/i
const COLOR_NAMES = /colou?r|tint|rgb|^col\d*$|_col$|Col$/i

const human = (id: string) => id.replace(/^(u_|u(?=[A-Z])|i(?=[A-Z])|uni_)/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase()) || id

export interface ReadOptions {
  style?: Style
  macros?: Record<string, string>
  /** the color the shader writes is already linear (Unity in its default linear mode, Unreal), not a screen color */
  linear?: boolean
}

// TouchDesigner's color helpers, added in front of the first line when a shader calls them, so line numbers stay the same
const TD_FNS: Record<string, string> = {
  TDHSVToRGB: 'vec3 TDHSVToRGB(vec3 c) { vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0); vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www); return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y); }',
  TDRGBToHSV: 'vec3 TDRGBToHSV(vec3 c) { vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0); vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g)); vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r)); float d = q.x - min(q.w, q.y); return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1.0e-10)), d / (q.x + 1.0e-10), q.x); }',
}

export function readGLSL(src: string, name = 'Untitled', opts: ReadOptions = {}): ReadResult {
  const td = Object.keys(TD_FNS).filter((n) => new RegExp('\\b' + n + '\\s*\\(').test(src) && !new RegExp('\\b(vec3|vec4)\\s+' + n + '\\s*\\(').test(src))
  if (td.length) src = td.map((n) => TD_FNS[n]).join(' ') + ' ' + src
  const { toks, notes } = preprocess(src, { HW_PERFORMANCE: '0', GL_ES: '1', ...opts.macros })
  const prog = parseProgram(toks)
  const E = new Eval()
  const b = E.b
  const fns = prog.globals.filter((g) => g.k === 'fn').map((g) => (g as { f: Fn }).f)
  for (const f of fns) { const l = E.fns.get(f.name) ?? []; l.push(f); E.fns.set(f.name, l) }
  const has = (n: string) => E.fns.has(n)
  const text = toks.map((t) => t.v)
  const uses = (n: string) => text.includes(n)

  // ---- which style this is
  let style: Style = 'glsl'
  if (opts.style) style = opts.style
  else if (has('mainImage')) style = 'shadertoy'
  else if (uses('TDOutputSwizzle') || uses('vUV') || uses('uTDOutputInfo')) style = 'touchdesigner'
  else if (uses('RENDERSIZE') || uses('isf_FragNormCoord') || uses('TIME')) style = 'isf'
  else if (uses('u_resolution') || uses('u_time') || uses('u_mouse')) style = 'book'
  else if (uses('vUv')) style = 'three'
  else if (uses('resolution') && uses('time') && uses('gl_FragColor')) style = 'sandbox'

  // ---- shader inputs
  const R = RESOLUTION
  const cache = new Map<string, Val>()
  const memo = (k: string, f: () => Val) => { let v = cache.get(k); if (!v) { v = f(); cache.set(k, v) } return { t: v.t, c: v.c.slice() } }
  const src3 = (op: string, n = 3): Val => memo(op, () => { const w = b.source(op, OPS[op].out.out as 'vec3'); if (op === 'uv') b.markZ(w); return { t: n === 1 ? F : vec(n), c: b.parts(w, n) } })
  const time = () => memo('time', () => { const w = b.source('time', 'float'); b.ranges.set(w, [0, Infinity]); return { t: F, c: [{ f: w }] } })
  const uv2 = () => { const u = src3('uv'); return { t: vec(2), c: u.c.slice(0, 2) } }
  const fragCoord = () => memo('fragCoord', () => ({ t: vec(2), c: b.ew('mul', uv2().c, [R, R]) }))
  const tdInfo = (): Val => ({ t: { k: 'struct', name: 'TDTexInfo', fields: [{ name: 'res', t: vec(4) }, { name: 'depth', t: vec(4) }] }, c: [1 / R, 1 / R, R, R, 1, 1, 0, 0] })
  const mapInput = (n: string): Val | undefined => {
    if (TIME.includes(n)) return time()
    if (RES.includes(n)) return n === 'iResolution' ? { t: vec(3), c: [R, R, 1] } : { t: vec(2), c: [R, R] }
    if (MOUSE.includes(n)) {
      return n === 'iMouse' ? { t: vec(4), c: [0, 0, 0, 0] } : n === 'mouse' ? { t: vec(2), c: [0.5, 0.5] } : { t: vec(2), c: [R / 2, R / 2] }
    }
    switch (n) {
      case 'iFrame': case 'FRAMEINDEX': return { t: I, c: [b.s('floor', b.s('mul', time().c[0], 60))] }
      case 'iTimeDelta': case 'TIMEDELTA': return { t: F, c: [1 / 60] }
      case 'iFrameRate': return { t: F, c: [60] }
      case 'iDate': case 'DATE': return { t: vec(4), c: [2026, 0, 1, time().c[0]] }
      case 'iSampleRate': return { t: F, c: [44100] }
      case 'iChannelTime': return { t: { k: 'arr', of: F, len: 4 }, c: [0, 0, 0, 0].map(() => time().c[0]) }
      case 'iChannelResolution': return { t: { k: 'arr', of: vec(3), len: 4 }, c: Array(12).fill(0) }
      case 'gl_FragCoord': return { t: vec(4), c: [...fragCoord().c, 0.5, 1] }
      case 'gl_FrontFacing': return { t: { k: 'num', b: 'bool', n: 1 }, c: [1] }
      case 'gl_PointCoord': return uv2()
      case 'surfacePosition': return { t: vec(2), c: b.ew('mul', b.ew('sub', uv2().c, [0.5]), [2]) }
      // Inoscula's own inputs, for shaders written for Inoscula in GLSL
      case 'uv': case 'vUv': case 'v_uv': case 'isf_FragNormCoord': return uv2()
      case 'vUV': return { t: vec(3), c: [...uv2().c, 0] }
      case 'object_pos': case 'world_pos': case 'normal': case 'object_normal': case 'view_dir': case 'light_dir': case 'light_color': return src3(n)
      case 'curvature': case 'occlusion': case 'object_size': return src3(n, 1)
      // Unity's
      case '_Time': if (style !== 'unity') break; return { t: vec(4), c: [b.s('mul', time().c[0], 1 / 20), time().c[0], b.s('mul', time().c[0], 2), b.s('mul', time().c[0], 3)] }
      case '_SinTime': if (style !== 'unity') break; return { t: vec(4), c: [1 / 8, 1 / 4, 1 / 2, 1].map((k) => b.s('sin', b.s('mul', time().c[0], k))) }
      case '_CosTime': if (style !== 'unity') break; return { t: vec(4), c: [1 / 8, 1 / 4, 1 / 2, 1].map((k) => b.s('cos', b.s('mul', time().c[0], k))) }
      case 'unity_DeltaTime': if (style !== 'unity') break; return { t: vec(4), c: [1 / 60, 60, 1 / 60, 60] }
      case '_ScreenParams': if (style !== 'unity') break; return { t: vec(4), c: [R, R, 1 + 1 / R, 1 + 1 / R] }
      case '_WorldSpaceCameraPos': if (style !== 'unity') break; return { t: vec(3), c: [0, 0, 5] }
      // TouchDesigner's, from its GLSL TOP: TDTexInfo holds (1/width, 1/height, width, height) and (1/depth, depth, depth offset, unused)
      case 'uTDOutputInfo': return tdInfo()
      case 'uTD2DInfos': case 'uTD3DInfos': case 'uTD2DArrayInfos': case 'uTDCubeInfos': {
        const one = tdInfo()
        return { t: { k: 'arr', of: one.t, len: 8 }, c: Array.from({ length: 8 }, () => one.c).flat() }
      }
      case 'uTDPass': case 'uTDCurrentDepth': return { t: I, c: [0] }
      case 'PI': return { t: F, c: [Math.PI] }
      case 'TAU': return { t: F, c: [Math.PI * 2] }
    }
    return undefined
  }
  // a declared "in" or "varying": what the vertex shader would have passed in
  const varying = (n: string, t: Ty, line: number): Val => {
    const m = mapInput(n)
    if (m && size(m.t) >= size(t)) return { t, c: m.c.slice(0, size(t)) }
    const fill = (c: S[]) => ({ t, c: [...c, ...Array(Math.max(0, size(t) - c.length)).fill(0)].slice(0, size(t)) })
    if (UV_NAMES.test(n) || n === 'vUV') return fill(uv2().c)
    if (NORMAL_NAMES.test(n)) return fill(src3('normal').c)
    if (WPOS_NAMES.test(n)) return fill(src3('world_pos').c)
    if (POS_NAMES.test(n)) return fill(src3('object_pos').c)
    if (/col/i.test(n)) return fill([1, 1, 1, 1])
    E.warn(line, `"${n}" comes from a vertex shader, which a material does not have. It is set to 0. If it holds texture coordinates, name it vUv; a normal, vNormal; a position, vPosition.`)
    return { t, c: E.zero(t) }
  }

  // ---- uniforms become parameters
  const params: Param[] = []
  const paramOf = new Map<string, Param>()
  const ids = new Set<string>()
  const uniform = (n: string, t: Ty, init: Expr | undefined, line: number): Val => {
    const m = mapInput(n)
    if (m && (size(m.t) === size(t) || t.k === 'arr')) return { t, c: m.c.slice(0, size(t)) }
    if (m && size(m.t) > size(t)) return { t, c: m.c.slice(0, size(t)) }
    if (t.k === 'sampler') return { t, c: [] }
    if (t.k === 'arr' || t.k === 'mat' || t.k === 'struct') {
      const v = init ? E.conv(E.eval(init), t, { line }) : { t, c: E.zero(t) }
      E.warn(line, `"${n}" is a ${show(t)} uniform. Only single numbers and vectors become sliders, so it is fixed at ${init ? 'its starting value' : '0'}.`)
      return v
    }
    if (t.k !== 'num') return { t, c: [] }
    const note = notes.get(line) ?? ''
    let id = safeId(n.replace(/^(u_|_+)/, '')) || 'param' // Unity's _Color becomes Color: two underscores in a row are not allowed in GLSL
    while (ids.has(id) || id in OPS) id += '_'
    ids.add(id)
    let def: S[] = init ? E.conv(E.eval(init), t, { line }).c : []
    if (def.some((x) => typeof x !== 'number')) def = []
    const isColor = /@colou?r/.test(note) || (t.n >= 3 && COLOR_NAMES.test(n))
    if (!def.length) {
      const dv = /@default\s+(-?[\d.]+)/.exec(note)
      const v = dv ? parseFloat(dv[1]) : t.b === 'bool' ? 0 : isColor ? 1 : ONE_NAMES.test(n) ? 1 : 0
      def = Array(t.n).fill(v)
      if (!dv && t.b !== 'bool') E.warn(line, `The uniform "${n}" has no starting value in the code, so it starts at ${v}. Change it with its slider, or give it one: uniform ${show(t)} ${n} = ${t.n === 1 ? v.toFixed(1) : `${show(t)}(${v.toFixed(1)})`};`)
    }
    const mk = (pid: string, type: Param['type'], d: number[], label: string): Param => {
      const p: Param = { id: pid, type, default: (type === 'float' ? d[0] : [d[0], d[1] ?? 0, d[2] ?? 0]) as Param['default'], label }
      const range = /@range\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(note)
      if (range && type === 'float') { p.min = parseFloat(range[1]); p.max = parseFloat(range[2]) }
      const st = /@step\s+([\d.]+)/.exec(note)
      if (st) p.step = parseFloat(st[1])
      const g = /@group\s+([^@]+)/.exec(note); if (g) p.group = g[1].trim()
      const ds = /@desc\s+([^@]+)/.exec(note); if (ds) p.desc = ds[1].trim()
      if (type === 'float' && (t.k === 'num' && t.b !== 'float')) p.step = p.step ?? 1
      if (type === 'float' && ((t.k === 'num' && t.b === 'bool') || /@toggle\b/.test(note))) Object.assign(p, { ui: 'toggle', min: 0, max: 1, step: 1 })
      if (type === 'float' && p.min === undefined && !p.ui) {
        const v = d[0]
        p.min = Math.min(0, v * 2, v - 1); p.max = Math.max(1, v * 2, v + 1)
        if (t.k === 'num' && t.b !== 'float') { p.min = Math.floor(p.min); p.max = Math.ceil(p.max) }
      }
      params.push(p); paramOf.set(pid, p)
      const w = '$' + pid
      b.setType(w, type === 'float' ? 'float' : 'vec3')
      if (type === 'float' && p.min !== undefined && p.max !== undefined && (range || p.ui)) b.ranges.set(w, [p.min, p.max])
      return p
    }
    const label = /@label\s+([^@]+)/.exec(note)?.[1].trim() ?? human(n)
    const nd = def.map((x) => x as number)
    if (t.n === 1) { mk(id, 'float', nd, label); return { t, c: [{ f: '$' + id }] } }
    const p = mk(id, isColor ? 'color' : 'vector', nd, label)
    const c: S[] = b.parts('$' + p.id, 3).slice(0, Math.min(3, t.n))
    if (t.n === 4) { mk(id + '_w', 'float', [nd[3]], label + ' W'); c.push({ f: '$' + id + '_w' }) }
    return { t, c }
  }

  // ---- outputs
  const outputs = new Map<string, Var>()
  let colorOut: { v: Var; display: boolean; alpha: boolean } | undefined
  const outVar = (n: string, t: Ty): Var => { const v: Var = { t, c: E.zero(t), base: key(1), name: n }; outputs.set(n, v); E.globals.set(n, v); return v }
  E.output = (n) => {
    if (n === 'gl_FragColor' || n === 'gl_FragData') { const v = outVar(n, vec(4)); v.c[3] = 1; colorOut = colorOut ?? { v, display: !opts.linear, alpha: true }; return v }
    if (n in SURFACE_OUTS && E.scopes.length) { const v = outVar(n, SURFACE_OUTS[n] === 1 ? F : vec(3)); if (n === 'alpha') v.c[0] = 1; return v }
    return undefined
  }
  E.builtin = (n) => mapInput(n)
  E.extra = (fn, a, e) => inosculaFn(E, fn, a, e)

  // ---- the top of the shader, in order
  for (const g of prog.globals) {
    if (g.k === 'struct') { E.struct(g.s); continue }
    if (g.k === 'fn') continue
    const ds = g.k === 'block' ? g.d : [g.d]
    for (const d of ds) {
      for (const v of d.vars) {
        b.line = v.line
        let t = E.type({ ...d.type, arr: [...d.type.arr, ...v.arr] }, v)
        const q = d.quals
        if (q.includes('uniform')) { const val = uniform(v.name, t, v.init, v.line); E.globals.set(v.name, { t: val.t, c: val.c, base: key(1), isConst: true, name: v.name }); continue }
        if ((q.includes('in') || q.includes('varying') || q.includes('attribute')) && !q.includes('out')) { const val = varying(v.name, t, v.line); E.globals.set(v.name, { t, c: val.c, base: key(1), isConst: true, name: v.name }); continue }
        if (q.includes('out')) {
          const ov = outVar(v.name, t)
          if (t.k === 'num' && t.n >= 3 && !colorOut) { if (t.n === 4) ov.c[3] = 1; colorOut = { v: ov, display: true, alpha: t.n === 4 } }
          continue
        }
        let val: Val
        if (v.init) { val = v.init.k === 'init' ? E.initList(v.init, t) : E.eval(v.init); if (t.k === 'arr' && t.len === -1 && val.t.k === 'arr') t = val.t; val = E.conv(val, t, v) }
        else val = { t, c: E.zero(t) }
        E.globals.set(v.name, { t, c: val.c.slice(), base: key(1), isConst: q.includes('const'), name: v.name })
      }
    }
  }

  // ---- run it
  const main = E.fns.get('main')?.find((f) => f.params.length === 0)
  const image = E.fns.get('mainImage')?.find((f) => f.params.length >= 2)
  const callsImage = main && JSON.stringify(main.body).includes('"fn":"mainImage"')
  if (image && (!main || !callsImage)) {
    // Shadertoy: mainImage(out vec4 fragColor, in vec2 fragCoord)
    const fc = outVar('fragColor', vec(4))
    fc.c[3] = 1
    colorOut = { v: fc, display: true, alpha: false }
    const L = { v: fc, t: vec(4) as Ty, alts: [{ c: 1 as S, idx: [0, 1, 2, 3] }] }
    const pt = E.type(image.params[0].type, image)
    if (size(pt) < 3) E.err('mainImage() should start with "out vec4 fragColor".', image)
    const args: Val[] = [{ t: pt, c: E.zero(pt) }, fragCoord()]
    if (image.params.length > 2) args.push(...image.params.slice(2).map((p) => { const t = E.type(p.type, image); return { t, c: E.zero(t) } }))
    const outs = image.params.map((p, i) => (i === 0 ? { ...L, t: pt, alts: [{ c: 1 as S, idx: [0, 1, 2, 3].slice(0, size(pt)) }] } : null))
    E.inline(image, args, outs, image)
  } else if (main) {
    E.inline(main, [], [], main)
  } else {
    throw new CodeError('this shader has no main() or mainImage() function, so there is nothing to run. Shadertoy shaders start with void mainImage(out vec4 fragColor, in vec2 fragCoord); others with void main().', 1)
  }

  if (MOUSE.some((m) => text.filter((t) => t === m).length > (prog.globals.some((g) => g.k === 'decl' && g.d.vars.some((v) => v.name === m)) ? 1 : 0))) E.warn(0, 'The mouse is not available on a material, so the shader sees it at rest.')

  // the fract(sin(x) * 43758.5453) random trick: its pattern hangs on the last digits of sin(), which every
  // graphics card and Cycles round a little differently
  for (let i = 0, start = 0; i < toks.length; i++) {
    if (toks[i].v !== ';' && toks[i].v !== '{' && toks[i].v !== '}') continue
    const st = toks.slice(start, i)
    start = i + 1
    const big = st.some((t, j) => t.k === 'num' && numValue(t.v) >= 1000 && (st[j - 1]?.v === '*' || st[j + 1]?.v === '*'))
    if (big && st.some((t) => t.v === 'sin') && st.some((t) => t.v === 'fract')) {
      E.warn(st[0].line, 'This line makes random numbers with fract(sin(x) * a big number). That trick depends on how each graphics card rounds sin(), so the random pattern can come out different in Blender (Cycles) and on other computers, even on Shadertoy itself. The look stays the same. For a pattern that matches everywhere, use white_noise(p) instead, which gives a random number from 0 to 1.')
      break
    }
  }

  // ---- the graph
  const out: Graph['output'] = { color: [0, 0, 0] }
  let shading: 'lit' | 'unlit' = 'unlit'
  const set = new Set([...outputs.keys()])
  b.line = 0
  const linear = (c: S[]) => {
    // display color (what Shadertoy and the browser show) to linear color (what Inoscula works in), exactly
    const lo = b.ew('mul', c, [1 / 12.92])
    const hi = b.ew('pow', b.ew('mul', b.ew('add', c, [0.055]), [1 / 1.055]), [2.4])
    return c.map((_, i) => b.s('mix', lo[i], hi[i], b.s('greater', c[i], 0.04045)))
  }
  if (set.has('color')) out.color = b.v3(outputs.get('color')!.c)
  else if (colorOut) {
    const c = colorOut.v.c
    const rgb = colorOut.v.t.k === 'num' && colorOut.v.t.n === 1 ? [c[0], c[0], c[0]] : c.slice(0, 3)
    out.color = b.v3(colorOut.display ? linear(rgb) : rgb)
    if (colorOut.alpha && size(colorOut.v.t) === 4 && c[3] !== 1) out.alpha = b.fw(b.s('clamp', c[3], 0, 1))
  } else throw new CodeError('this shader never sets a color. Write the result to fragColor, gl_FragColor, an "out vec4", or color.', main?.line ?? 1)
  for (const [n, v] of outputs) {
    if (!(n in SURFACE_OUTS) || n === 'color') continue
    const w = SURFACE_OUTS[n] === 3 ? b.v3(v.c) : b.fw(v.c[0])
    ;(out as Record<string, Wire>)[n] = w
    if (LIT.includes(n)) shading = 'lit'
  }
  let surface: 'solid' | 'cutout' | undefined
  if (E.discard !== 0) {
    const keep = E.not(E.discard)
    out.alpha = out.alpha === undefined ? b.fw(keep) : b.fw(b.s('mul', keep, typeof out.alpha === 'number' ? out.alpha : { f: out.alpha as string }))
    surface = 'cutout'
  }

  const graph: Graph = { inoscula: '0.1', name, nodes: b.nodes, output: out }
  if (shading === 'lit') graph.shading = 'lit'
  if (surface) graph.surface = surface
  prune(graph)
  // only the parameters the picture still uses
  const used = new Set<string>()
  const note = (w: unknown) => { if (typeof w === 'string' && w.startsWith('$')) used.add(w.slice(1)) }
  for (const n of graph.nodes) for (const w of Object.values(n.in ?? {})) note(w)
  for (const w of Object.values(out)) note(w)
  const ps = params.filter((p) => used.has(p.id))
  if (ps.length) graph.params = ps
  lineMap.set(graph, new Map([...b.lineOf].filter(([id]) => graph.nodes.some((n) => n.id === id))))
  return { graph, style, warnings: E.warnings }
}

/** drop nodes nothing reads (made along the way, then not needed) */
function prune(g: Graph) {
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const live = new Set<string>()
  const stack: unknown[] = Object.values(g.output)
  while (stack.length) {
    const w = stack.pop()
    if (typeof w !== 'string' || w.startsWith('$')) continue
    const id = w.split('.')[0]
    if (live.has(id)) continue
    live.add(id)
    const n = byId.get(id)
    if (n) stack.push(...Object.values(n.in ?? {}))
  }
  g.nodes = g.nodes.filter((n) => live.has(n.id))
}

/** Inoscula's own pattern functions, for shaders that call them without writing their own */
function inosculaFn(E: Eval, fn: string, a: Val[], e: Expr): Val | undefined {
  const b = E.b
  const p3 = (v: Val) => b.v3(v.c.slice(0, 3), true)
  const num = (v: Val | undefined, d: number) => (v ? b.fw(v.c[0]) : d)
  switch (fn) {
    case 'noise': {
      if (a.length < 1 || a.length > 5) return undefined
      const d = OPS.noise.ins
      const id = b.node('noise', { p: p3(a[0]), scale: num(a[1], d[1][2] as number), detail: num(a[2], d[2][2] as number), roughness: num(a[3], d[3][2] as number), lacunarity: num(a[4], d[4][2] as number) }, 'float')
      b.ranges.set(id, [0, 1])
      return { t: F, c: [{ f: id }] }
    }
    case 'white_noise': case 'hash': {
      if (a.length !== 1) return undefined
      const id = b.node('white_noise', { p: p3(a[0]) }, 'float')
      b.ranges.set(id, [0, 1])
      return { t: F, c: [{ f: id }] }
    }
    case 'voronoi': {
      if (a.length < 1 || a.length > 3) return undefined
      const id = b.node('voronoi', { p: p3(a[0]), scale: num(a[1], 5), randomness: num(a[2], 1) }, 'float')
      return { t: F, c: [{ f: id }] }
    }
    case 'TDOutputSwizzle': return a[0]
    case 'TDDither': return a.length === 1 ? a[0] : undefined
    case 'TDPerlinNoise': case 'TDSimplexNoise':
      return E.err(`"${fn}" is TouchDesigner's own noise, and other programs do not have it. Use noise(p) instead. It gives values from 0 to 1, the same in every program.`, e)
    case 'one_minus': return a.length === 1 ? { t: a[0].t, c: b.ew('one_minus', a[0].c) } : undefined
  }
  void e
  return undefined
}

export type { Stmt }
