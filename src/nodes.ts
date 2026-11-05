// Node views: the shader as the node graph each program shows. A view is plain data (nodes, sockets, wires), so
// Inoscula Studio can draw it and the exporters that build node graphs can be checked against it.
import { type Arg, type IR, OPS, rampStops } from './spec.ts'
import { toBlender } from './targets/blender.ts'

export type SockType = 'float' | 'vec3' | 'color' | 'shader'
export interface GIn { n: string; t: SockType; v?: unknown; hide?: boolean; nosock?: boolean }
export interface GNode {
  id: string; title: string; cat: string; ins: GIn[]; outs: { n: string; t: SockType }[]
  line?: number; note?: string; extra?: 'ramp'; stops?: [number, number[]][]; sink?: boolean | number; col?: number
  /** a color swatch, as Unreal draws on its color constants and parameters */
  swatch?: number[]
  /** where the layout put it, and its size */
  x?: number; y?: number; w?: number; h?: number
}
export interface GLink { a: string; ao: number; b: string; bi: number }
export interface NodeView { nodes: GNode[]; links: GLink[]; theme: string; legend?: string; side?: boolean; laid?: boolean }

const baseOf = (id: string) => id.replace(/_(x|y|z|color|position)$/, '')
const outIdx = (id: string) => ({ x: 0, y: 1, z: 2, color: 1, position: 2 } as Record<string, number>)[/_(x|y|z|color|position)$/.exec(id)?.[1] ?? ''] ?? 0
const ty = (t: string): SockType => (t === 'vec3' ? 'vec3' : 'float')

// ------------------------------------------------------------------ Inoscula's own graph
const SOURCE_TITLE: Record<string, string> = { uv: 'UV', object_pos: 'Object Position', object_normal: 'Object Normal', world_pos: 'World Position', normal: 'Normal', view_dir: 'View Direction', time: 'Time', light_dir: 'Light Direction', light_color: 'Light Color', curvature: 'Curvature', occlusion: 'Occlusion', object_size: 'Object Size' }
export function inosculaView(ir: IR, lines?: Map<string, number>): NodeView {
  const nodes: GNode[] = [], links: GLink[] = []
  const have = new Set<string>()
  const ensureSrc = (id: string) => {
    if (have.has(id)) return
    have.add(id)
    if (id.startsWith('p_')) {
      const p = ir.params.find((q) => 'p_' + q.id === id)
      nodes.push({ id, title: p?.label ?? id.slice(2), cat: 'param', ins: [], outs: [{ n: p?.type === 'color' ? 'color' : 'value', t: p?.t === 'vec3' ? (p.type === 'color' ? 'color' : 'vec3') : 'float' }], note: p ? `parameter ${p.id}` : undefined })
    }
  }
  const wire = (a: Arg, to: string, bi: number) => {
    if (a.k !== 'ref') return
    const b = baseOf(a.id)
    ensureSrc(b)
    links.push({ a: b, ao: outIdx(a.id), b: to, bi })
  }
  for (const s of ir.steps) {
    const def = OPS[s.op]
    const outs = Object.entries(s.outs).map(([n, t]) => ({ n: n === 'out' ? (def.source ? 'value' : 'result') : n, t: ty(t) }))
    const title = def.source ? (SOURCE_TITLE[s.op] ?? s.op) : s.op === 'value' ? 'value' : s.op.replace(/_/g, ' ')
    const nm = s.node.replace(/_\d+$/, '')
    nodes.push({
      id: s.id, title, cat: def.source ? 'input' : 'converter', outs,
      ins: def.ins.map(([n], i) => { const a = s.args[i]; return { n, t: ty(a?.type ?? 'float'), v: a?.k === 'lit' ? a.v : undefined } }),
      line: lines?.get(s.node), note: !def.source && nm !== s.op ? nm : s.op === 'value' ? String(s.set.v) : undefined,
      ...(s.op === 'ramp' ? { extra: 'ramp' as const, stops: rampStops(s.set).map(([p, c]) => [p, c] as [number, number[]]) } : {}),
    })
    have.add(s.id)
    s.args.forEach((a, i) => wire(a, s.id, i))
  }
  const outs: [string, Arg | null][] = [['color', ir.color], ['alpha', ir.alpha], ...(ir.lit ? [['roughness', ir.roughness], ['metallic', ir.metallic], ['bump', ir.bump], ['emission', ir.emission], ...Object.entries(ir.layers)] as [string, Arg | null][] : []), ...(ir.outline ? [['outline', ir.outline.width], ['outline color', ir.outline.color], ['outline breakup', ir.outline.breakup]] as [string, Arg][] : [])]
  const used = outs.filter(([, a]) => a)
  nodes.push({ id: '__out', title: ir.lit ? 'surface (lit)' : 'surface (unlit)', cat: 'output', sink: true, outs: [], ins: used.map(([n, a]) => ({ n, t: a!.type === 'vec3' ? 'vec3' : 'float', v: a!.k === 'lit' ? a!.v : undefined })) })
  used.forEach(([, a], i) => wire(a!, '__out', i))
  return { nodes, links, theme: 'inoscula', legend: 'Inoscula graph. Double-click a node to jump to its code.' }
}

// ------------------------------------------------------------------ Blender: read back the nodes the export builds
type BSpec = { title: string; cat: string; ins: [string, SockType, unknown, string?][]; outs: [string, SockType, string?][] }
const MATH_UNARY = new Set(['ABSOLUTE', 'FLOOR', 'FRACT', 'SINE', 'COSINE', 'EXPONENT', 'SQRT', 'FRACTION', 'NORMALIZE', 'LENGTH'])
const pretty = (op: string) => ({ FRACT: 'Fraction', FRACTION: 'Fraction', SQRT: 'Square Root', ARCTAN2: 'Arctan2', DOT_PRODUCT: 'Dot Product', GREATER_THAN: 'Greater Than', LESS_THAN: 'Less Than' } as Record<string, string>)[op] ?? op.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
const BL: Record<string, BSpec> = {
  ShaderNodeMath: { title: 'Math', cat: 'converter', ins: [['Value', 'float', 0.5], ['Value', 'float', 0.5], ['Value', 'float', 0.5]], outs: [['Value', 'float']] },
  ShaderNodeVectorMath: { title: 'Vector Math', cat: 'vector', ins: [['Vector', 'vec3', [0, 0, 0]], ['Vector', 'vec3', [0, 0, 0]], ['Vector', 'vec3', [0, 0, 0]]], outs: [['Vector', 'vec3'], ['Value', 'float']] },
  ShaderNodeMix: { title: 'Mix', cat: 'converter', ins: [['Factor', 'float', 0.5, 'Factor_Float'], ['A', 'float', 0, 'A_Float'], ['B', 'float', 0, 'B_Float'], ['A', 'vec3', [0, 0, 0], 'A_Vector'], ['B', 'vec3', [0, 0, 0], 'B_Vector']], outs: [['Result', 'float', 'Result_Float'], ['Result', 'vec3', 'Result_Vector']] },
  ShaderNodeMapRange: { title: 'Map Range', cat: 'converter', ins: [['Value', 'float', 1], ['From Min', 'float', 0], ['From Max', 'float', 1], ['To Min', 'float', 0], ['To Max', 'float', 1]], outs: [['Result', 'float']] },
  ShaderNodeClamp: { title: 'Clamp', cat: 'converter', ins: [['Value', 'float', 1], ['Min', 'float', 0], ['Max', 'float', 1]], outs: [['Result', 'float']] },
  ShaderNodeCombineXYZ: { title: 'Combine XYZ', cat: 'converter', ins: [['X', 'float', 0], ['Y', 'float', 0], ['Z', 'float', 0]], outs: [['Vector', 'vec3']] },
  ShaderNodeSeparateXYZ: { title: 'Separate XYZ', cat: 'converter', ins: [['Vector', 'vec3', [0, 0, 0]]], outs: [['X', 'float'], ['Y', 'float'], ['Z', 'float']] },
  ShaderNodeValue: { title: 'Value', cat: 'input', ins: [], outs: [['Value', 'float']] },
  ShaderNodeTexNoise: { title: 'Noise Texture', cat: 'texture', ins: [['Vector', 'vec3', undefined], ['Scale', 'float', 5], ['Detail', 'float', 2], ['Roughness', 'float', 0.5], ['Lacunarity', 'float', 2], ['Distortion', 'float', 0]], outs: [['Fac', 'float'], ['Color', 'color']] },
  ShaderNodeTexVoronoi: { title: 'Voronoi Texture', cat: 'texture', ins: [['Vector', 'vec3', undefined], ['Scale', 'float', 5], ['Detail', 'float', 0], ['Roughness', 'float', 0.5], ['Lacunarity', 'float', 2], ['Randomness', 'float', 1]], outs: [['Distance', 'float'], ['Color', 'color'], ['Position', 'vec3']] },
  ShaderNodeTexWhiteNoise: { title: 'White Noise Texture', cat: 'texture', ins: [['Vector', 'vec3', undefined]], outs: [['Value', 'float'], ['Color', 'color']] },
  ShaderNodeValToRGB: { title: 'Color Ramp', cat: 'converter', ins: [['Fac', 'float', 0.5]], outs: [['Color', 'color'], ['Alpha', 'float']] },
  ShaderNodeTexCoord: { title: 'Texture Coordinate', cat: 'input', ins: [], outs: [['Generated', 'vec3'], ['Normal', 'vec3'], ['UV', 'vec3'], ['Object', 'vec3'], ['Camera', 'vec3'], ['Window', 'vec3'], ['Reflection', 'vec3']] },
  ShaderNodeNewGeometry: { title: 'Geometry', cat: 'input', ins: [], outs: [['Position', 'vec3'], ['Normal', 'vec3'], ['Tangent', 'vec3'], ['True Normal', 'vec3'], ['Incoming', 'vec3'], ['Parametric', 'vec3'], ['Backfacing', 'float'], ['Pointiness', 'float'], ['Random Per Island', 'float']] },
  ShaderNodeVertexColor: { title: 'Color Attribute', cat: 'input', ins: [], outs: [['Color', 'color'], ['Alpha', 'float']] },
  ShaderNodeAttribute: { title: 'Attribute', cat: 'input', ins: [], outs: [['Color', 'color'], ['Vector', 'vec3'], ['Fac', 'float'], ['Alpha', 'float']] },
}
function pyVal(s: string): unknown {
  s = s.trim()
  if (s === 'True') return 1
  if (s === 'False') return 0
  const t = /^\(([^()]*)\)$/.exec(s)
  if (t) return t[1].split(',').map((x) => +x).filter((x) => !Number.isNaN(x)).slice(0, 3)
  return Number.isNaN(+s) ? s : +s
}
function splitStatements(line: string): string[] {
  const out: string[] = []
  let depth = 0, str = false, cur = ''
  for (const ch of line) {
    if (ch === '"') str = !str
    if (!str && (ch === '(' || ch === '[')) depth++
    if (!str && (ch === ')' || ch === ']')) depth--
    if (!str && depth === 0 && ch === ';') { out.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}
export function blenderView(ir: IR, scriptIn?: string): NodeView {
  const script = scriptIn ?? toBlender(ir)
  const groupPart = script.split('\n# ---- the material')[0]
  type BN = { id: string; kind: string; spec: BSpec; props: Record<string, string>; vals: Map<string, unknown>; label?: string; note?: string; stops?: [number, number[]][] }
  const bn = new Map<string, BN>()
  const order: string[] = []
  const gins: { n: string; t: SockType }[] = [], gouts: { n: string; t: SockType }[] = [], goutVals = new Map<string, unknown>()
  const wires: [string, string][] = []
  const kindT = (k: string): SockType => (k === 'NodeSocketColor' ? 'color' : k === 'NodeSocketVector' ? 'vec3' : 'float')
  for (const raw of groupPart.split('\n')) {
    for (const st of splitStatements(raw)) {
      let m: RegExpExecArray | null
      if ((m = /^(\w+) = node\("(\w+)", /.exec(st))) { const spec = BL[m[2]]; if (spec) { bn.set(m[1], { id: m[1], kind: m[2], spec, props: {}, vals: new Map() }); order.push(m[1]) } continue }
      if ((m = /^(\w+)\.(operation|data_type|interpolation_type|factor_mode|clamp_type) = "([^"]*)"$/.exec(st))) { bn.get(m[1])?.props && (bn.get(m[1])!.props[m[2]] = m[3]); continue }
      if ((m = /^(\w+)\.label = "([^"]*)"$/.exec(st))) { const n = bn.get(m[1]); if (n) n.label = m[2]; continue }
      if ((m = /^(\w+)\.outputs\[0\]\.default_value = (.+)$/.exec(st))) { bn.get(m[1])?.vals.set('__value', pyVal(m[2])); continue }
      if ((m = /^drive_time\((\w+)\./.exec(st))) { const n = bn.get(m[1]); if (n) n.note = 'driver: frame / fps'; continue }
      if ((m = /^ramp_setup\((\w+), "(\w+)", \[(.*)\]\)$/.exec(st))) {
        const n = bn.get(m[1]); if (!n) continue
        n.props.interpolation = m[2]
        n.stops = [...m[3].matchAll(/\((-?[\d.e-]+), \((-?[\d.e-]+), (-?[\d.e-]+), (-?[\d.e-]+)\)\)/g)].map((x) => [+x[1], [+x[2], +x[3], +x[4]]])
        continue
      }
      if ((m = /^(?:attr|osz_a)\.attribute_name = "([^"]*)"$/.exec(st))) continue
      if ((m = /^sock_in\("((?:[^"\\]|\\.)*)", "(\w+)"/.exec(st))) { gins.push({ n: JSON.parse(`"${m[1]}"`), t: kindT(m[2]) }); continue }
      if ((m = /^g\.interface\.new_socket\("([^"]*)", in_out="OUTPUT", socket_type="(\w+)"\)$/.exec(st))) { gouts.push({ n: m[1], t: kindT(m[2]) }); continue }
      if ((m = /^link\((.+), (go\.inputs\[.+\]|S\(\w+\.inputs, "[^"]+"\)|\w+\.inputs\[\d+\])\)$/.exec(st))) { wires.push([m[1], m[2]]); continue }
      if ((m = /^setv\((S\(\w+\.inputs, "[^"]+"\)|\w+\.inputs\[\d+\]), (.+)\)$/.exec(st))) { wires.push(['=' + m[2], m[1]]); continue }
      if ((m = /^go\.inputs\["([^"]+)"\]\.default_value = (.+)$/.exec(st))) { goutVals.set(m[1], pyVal(m[2].replace(/^\(\*/, '(').replace(/, 1\.0\)$/, ')'))); continue }
    }
  }
  // which sockets each node shows, the way Blender shows them for its settings
  const view = (n: BN) => {
    const s = n.spec, op = n.props.operation
    let ins = s.ins.map(([nm, t, v, idn]) => ({ nm, t, v, idn: idn ?? nm, hide: false }))
    let outs = s.outs.map(([nm, t, idn]) => ({ nm, t, idn: idn ?? nm, hide: false }))
    let title = n.label ?? s.title
    if (n.kind === 'ShaderNodeMath') { title = n.label ?? pretty(op); ins.forEach((x, i) => { x.hide = i >= (MATH_UNARY.has(op) ? 1 : 2) }) }
    if (n.kind === 'ShaderNodeVectorMath') {
      title = n.label ?? pretty(op); ins.forEach((x, i) => { x.hide = i >= (MATH_UNARY.has(op) ? 1 : 2) })
      outs.forEach((x) => { x.hide = (op === 'DOT_PRODUCT' || op === 'LENGTH') ? x.nm === 'Vector' : x.nm === 'Value' })
    }
    if (n.kind === 'ShaderNodeMix') {
      const v = n.props.data_type === 'VECTOR'
      ins.forEach((x) => { x.hide = x.idn !== 'Factor_Float' && (v ? !x.idn.endsWith('_Vector') : !x.idn.endsWith('_Float')) })
      outs.forEach((x) => { x.hide = v ? x.idn !== 'Result_Vector' : x.idn !== 'Result_Float' })
    }
    if (n.kind === 'ShaderNodeMapRange') title = n.label ?? 'Map Range'
    return { title, ins: ins.filter((x) => !x.hide), outs: outs.filter((x) => !x.hide) }
  }
  const views = new Map([...bn.values()].map((n) => [n.id, view(n)]))
  // a socket expression to [node, index]
  const resolve = (expr: string, side: 'in' | 'out'): [string, number] | null => {
    let m: RegExpExecArray | null
    if ((m = /^gin\("((?:[^"\\]|\\.)*)"\)$/.exec(expr))) { const n = JSON.parse(`"${m[1]}"`); return ['__gi', gins.findIndex((g) => g.n === n)] }
    if ((m = /^go\.inputs\["([^"]+)"\]$/.exec(expr))) return ['__go', gouts.findIndex((g) => g.n === m![1])]
    if ((m = /^S\((\w+)\.(inputs|outputs), "([^"]+)"\)$/.exec(expr)) || (m = /^(\w+)\.(inputs|outputs)\["([^"]+)"\]$/.exec(expr))) {
      const v = views.get(m[1]); if (!v) return null
      const list = m[2] === 'inputs' ? v.ins : v.outs
      let i = list.findIndex((x) => x.idn === m![3]); if (i < 0) i = list.findIndex((x) => x.nm === m![3])
      return i < 0 ? null : [m[1], i]
    }
    if ((m = /^(\w+)\.(inputs|outputs)\[(\d+)\]$/.exec(expr))) {
      const n = bn.get(m[1]), v = views.get(m[1]); if (!n || !v) return null
      // a plain index counts every socket, shown or not
      const all = m[2] === 'inputs' ? n.spec.ins.map(([nm, , , idn]) => idn ?? nm) : n.spec.outs.map(([nm, , idn]) => idn ?? nm)
      const want = all[+m[3]]
      const list = m[2] === 'inputs' ? v.ins : v.outs
      const i = list.findIndex((x) => x.idn === want)
      return i < 0 ? [m[1], Math.min(+m[3], list.length - 1)] : [m[1], i]
    }
    return null
  }
  const nodes: GNode[] = []
  const vals = new Map<string, unknown>()
  const links: GLink[] = []
  for (const [from, to] of wires) {
    const b = resolve(to, 'in'); if (!b) continue
    if (from.startsWith('=')) { vals.set(b.join(':'), pyVal(from.slice(1))); continue }
    const a = resolve(from, 'out'); if (!a) continue
    links.push({ a: a[0], ao: a[1], b: b[0], bi: b[1] })
  }
  nodes.push({ id: '__gi', title: 'Group Input', cat: 'group', ins: [], outs: gins.map((g) => ({ n: g.n, t: g.t })), col: 0 })
  for (const id of order) {
    const n = bn.get(id)!, v = views.get(id)!
    const ins: GIn[] = v.ins.map((x, i) => ({ n: x.nm, t: x.t, v: vals.has(`${id}:${i}`) ? vals.get(`${id}:${i}`) : x.v }))
    if (n.kind === 'ShaderNodeValue') ins.push({ n: '', t: 'float', v: n.vals.get('__value') ?? 0, nosock: true })
    if (n.kind === 'ShaderNodeAttribute') ins.push({ n: 'Name', t: 'float', v: 'inoscula_object_size', nosock: true })
    if (n.kind === 'ShaderNodeNewGeometry' || n.kind === 'ShaderNodeTexCoord') {
      // Blender shows every output; keep the ones in use plus their neighbors readable
    }
    nodes.push({ id, title: v.title, cat: n.spec.cat, ins, outs: v.outs.map((x) => ({ n: x.nm, t: x.t })), note: n.note ?? (n.kind === 'ShaderNodeTexNoise' ? '3D · fBM · Normalize' : n.kind === 'ShaderNodeTexVoronoi' ? '3D · F1 · Euclidean' : n.kind === 'ShaderNodeMix' && n.props.data_type === 'VECTOR' ? 'Vector · Uniform · Clamp Factor' : n.kind === 'ShaderNodeMix' ? 'Float · Clamp Factor' : n.kind === 'ShaderNodeMapRange' ? 'Smooth Step · Clamp' : n.kind === 'ShaderNodeValToRGB' ? (n.props.interpolation === 'CONSTANT' ? 'Constant' : 'Linear') : undefined),
      ...(n.stops ? { extra: 'ramp' as const, stops: n.stops } : {}) })
  }
  nodes.push({ id: '__go', title: 'Group Output', cat: 'group', sink: true, outs: [], ins: gouts.map((g) => ({ n: g.n, t: g.t, v: goutVals.get(g.n) })) })
  // keep only outputs of sources that are wired, so input nodes stay small
  for (const n of nodes) {
    if (n.id === '__gi' || !['ShaderNodeNewGeometry', 'ShaderNodeTexCoord'].includes(bn.get(n.id)?.kind ?? '')) continue
    const used = new Set(links.filter((l) => l.a === n.id).map((l) => l.ao))
    const keep = n.outs.map((_, i) => i).filter((i) => used.has(i))
    const remap = new Map(keep.map((o, i) => [o, i]))
    n.outs = keep.map((i) => n.outs[i])
    n.note = 'other outputs hidden'
    for (const l of links) if (l.a === n.id) l.ao = remap.get(l.ao)!
  }
  return { nodes, links, theme: 'blender', legend: `Blender · Shader Editor · inside the node group "Inoscula ${ir.name}". These are the nodes the Blender export builds, socket for socket.` }
}
/** The material around the group, as Blender shows it one level up. */
export function blenderMaterialView(ir: IR): NodeView {
  const gouts: { n: string; t: SockType }[] = [{ n: 'Color', t: 'color' }, { n: 'Alpha', t: 'float' }, ...(ir.lit ? [{ n: 'Roughness', t: 'float' }, { n: 'Metallic', t: 'float' }, { n: 'Height', t: 'float' }, { n: 'Emission', t: 'color' }] as { n: string; t: SockType }[] : [])]
  const gins = ir.params.map((p) => ({ n: p.label ?? p.id, t: (p.type === 'color' ? 'color' : p.t === 'vec3' ? 'vec3' : 'float') as SockType, v: p.default }))
  const nodes: GNode[] = [{ id: 'g', title: `Inoscula ${ir.name}`, cat: 'group', ins: gins, outs: gouts }]
  const links: GLink[] = []
  if (ir.lit) {
    nodes.push({ id: 'bs', title: 'Principled BSDF', cat: 'shader', ins: [{ n: 'Base Color', t: 'color' }, { n: 'Metallic', t: 'float' }, { n: 'Roughness', t: 'float' }, { n: 'Alpha', t: 'float', v: 1 }, { n: 'Normal', t: 'vec3' }, { n: 'Emission Color', t: 'color' }, { n: 'Emission Strength', t: 'float', v: 1 }], outs: [{ n: 'BSDF', t: 'shader' }] })
    links.push({ a: 'g', ao: 0, b: 'bs', bi: 0 }, { a: 'g', ao: 3, b: 'bs', bi: 1 }, { a: 'g', ao: 2, b: 'bs', bi: 2 }, { a: 'g', ao: 5, b: 'bs', bi: 5 })
    if (ir.alpha) links.push({ a: 'g', ao: 1, b: 'bs', bi: 3 })
    if (ir.bump) { nodes.push({ id: 'bp', title: 'Bump', cat: 'vector', ins: [{ n: 'Strength', t: 'float', v: 1 }, { n: 'Distance', t: 'float', v: 1 }, { n: 'Height', t: 'float' }, { n: 'Normal', t: 'vec3' }], outs: [{ n: 'Normal', t: 'vec3' }] }); links.push({ a: 'g', ao: 4, b: 'bp', bi: 2 }, { a: 'bp', ao: 0, b: 'bs', bi: 4 }) }
    nodes.push({ id: 'out', title: 'Material Output', cat: 'output', sink: true, ins: [{ n: 'Surface', t: 'shader' }, { n: 'Volume', t: 'shader' }, { n: 'Displacement', t: 'vec3' }], outs: [] })
    links.push({ a: 'bs', ao: 0, b: 'out', bi: 0 })
  } else {
    nodes.push({ id: 'em', title: 'Emission', cat: 'shader', ins: [{ n: 'Color', t: 'color' }, { n: 'Strength', t: 'float', v: 1 }], outs: [{ n: 'Emission', t: 'shader' }] })
    links.push({ a: 'g', ao: 0, b: 'em', bi: 0 })
    let last = 'em'
    if (ir.alpha) {
      nodes.push({ id: 'tr', title: 'Transparent BSDF', cat: 'shader', ins: [{ n: 'Color', t: 'color', v: [1, 1, 1] }], outs: [{ n: 'BSDF', t: 'shader' }] })
      nodes.push({ id: 'mx', title: 'Mix Shader', cat: 'shader', ins: [{ n: 'Fac', t: 'float' }, { n: 'Shader', t: 'shader' }, { n: 'Shader', t: 'shader' }], outs: [{ n: 'Shader', t: 'shader' }] })
      links.push({ a: 'g', ao: 1, b: 'mx', bi: 0 }, { a: 'tr', ao: 0, b: 'mx', bi: 1 }, { a: 'em', ao: 0, b: 'mx', bi: 2 }); last = 'mx'
    }
    nodes.push({ id: 'out', title: 'Material Output', cat: 'output', sink: true, ins: [{ n: 'Surface', t: 'shader' }, { n: 'Volume', t: 'shader' }, { n: 'Displacement', t: 'vec3' }], outs: [] })
    links.push({ a: last, ao: 0, b: 'out', bi: 0 })
  }
  return { nodes, links, theme: 'blender', legend: `Blender · Shader Editor · the material "${ir.name}". Select the group node and press Tab to go inside.` }
}

// ------------------------------------------------------------------ one layout for the node view and the exports
// Columns: each node sits one column right of the furthest node that feeds it, outputs in the last column, and each
// column is ordered by where its inputs come from so wires cross less. Sizes are in the node view's pixels, which are
// also Unreal's graph units, so the Unreal script places every expression where the Nodes tab draws it.
// side: inputs and outputs on the same rows (Unreal, Godot, Unity) or stacked, outputs first (Blender, Inoscula).
export const NODE_ROW = 20, NODE_HEAD = 24
const charW = 6.95, boldW = 7.6
export function nodeSize(n: GNode, side: boolean): { w: number; h: number } {
  const vis = n.ins.filter((i) => !i.hide)
  const fmt = (v: unknown) => Array.isArray(v) ? v.map((x) => +(+x).toFixed(2)).join(', ') : typeof v === 'number' ? String(+v.toFixed(3)) : String(v)
  const inW = Math.max(0, ...vis.map((i) => i.n.length * charW + (i.v !== undefined ? fmt(i.v).length * charW + 16 : 0)))
  const outW = Math.max(0, ...n.outs.map((o) => o.n.length * charW))
  const swatch = n.swatch ? 1 : 0
  const w = Math.ceil(Math.max(side ? 96 : 120, n.title.length * boldW + 26, side ? inW + outW + 46 + swatch * 52 : Math.max(inW, outW) + 34, n.extra ? 150 : 0, n.note ? Math.min(240, n.note.length * charW + 20) : 0))
  const rows = side ? Math.max(vis.length, n.outs.length, swatch ? 3 : 0) : vis.length + n.outs.length
  const h = NODE_HEAD + rows * NODE_ROW + (n.extra ? 22 : 0) + (n.note ? 18 : 0) + 8
  return { w, h }
}
export function layoutNodes(G: { nodes: GNode[]; links: GLink[] }, side = false, gapX = 70, gapY = 18) {
  const byId = new Map(G.nodes.map((n) => [n.id, n]))
  const feeds = new Map(G.nodes.map((n) => [n.id, [] as string[]]))
  for (const l of G.links) if (byId.has(l.a) && byId.has(l.b)) feeds.get(l.b)!.push(l.a)
  const col = new Map<string, number>()
  const colOf = (id: string, seen = new Set<string>()): number => {
    if (col.has(id)) return col.get(id)!
    if (seen.has(id)) return 0
    seen.add(id)
    const n = byId.get(id)!
    const c = n.col ?? Math.max(-1, ...feeds.get(id)!.map((f) => colOf(f, seen))) + 1
    col.set(id, c); return c
  }
  G.nodes.forEach((n) => colOf(n.id))
  // inputs, parameters and constants sit just left of the first node that uses them, not all at the far left
  const uses = new Map<string, number[]>()
  for (const l of G.links) if (byId.has(l.a) && byId.has(l.b)) (uses.get(l.a) ?? uses.set(l.a, []).get(l.a)!).push(col.get(l.b)!)
  for (const n of G.nodes) if (n.col === undefined && !n.sink && !feeds.get(n.id)!.length && uses.has(n.id)) col.set(n.id, Math.max(0, Math.min(...uses.get(n.id)!) - 1))
  const last = Math.max(0, ...col.values())
  for (const n of G.nodes) if (n.sink) col.set(n.id, last + (n.sink === true ? 0 : n.sink) + (G.nodes.some((m) => !m.sink && col.get(m.id) === last) ? 1 : 0))
  for (const n of G.nodes) Object.assign(n, nodeSize(n, side))
  const cols: GNode[][] = []
  for (const n of G.nodes) (cols[col.get(n.id)!] ??= []).push(n)
  let x = 0
  const cy = new Map<string, number>()
  for (const c of cols) {
    if (!c) continue
    const k = new Map(c.map((n) => { const f = feeds.get(n.id)!.map((id) => cy.get(id)).filter((v) => v !== undefined) as number[]; return [n.id, f.length ? f.reduce((a, b) => a + b, 0) / f.length : 0] }))
    c.sort((a, b) => k.get(a.id)! - k.get(b.id)!)
    const w = Math.max(...c.map((n) => n.w!))
    let y = 0
    for (const n of c) { n.x = x; n.y = y; y += n.h! + gapY }
    // each column is centered on the same line, so the graph reads left to right without drifting downwards
    for (const n of c) { n.y! -= Math.round((y - gapY) / 2); cy.set(n.id, n.y! + n.h! / 2) }
    x += w + gapX
  }
  return G
}
