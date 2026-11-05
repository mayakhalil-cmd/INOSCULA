// Inoscula: one shader graph, rebuilt natively in every realtime engine.
// This file is the whole language: the graph format, every node, and the checker that turns a graph into a
// typed, ordered list of steps (the IR) that every target prints in its own way.
//
// Space convention (the "canonical space"): Z up, right handed, meters, UV origin bottom left. This is Blender's
// convention, so Blender graphs stay clean; code targets convert their inputs into it with one line each.

export type Type = 'float' | 'vec3'
export type Lit = number | [number, number, number]

/** A wire into a node input: "node", "node.output", "$param", or a literal number / [x, y, z]. */
export type Wire = string | Lit

export interface Param {
  id: string
  type: 'float' | 'color' | 'vector'
  default: Lit
  label?: string
  min?: number
  max?: number
  // how the control is shown: a slider (the default), an on/off switch, or a list of named choices (0, 1, 2...)
  ui?: 'toggle' | 'menu'
  options?: string[]
  // slider steps, for whole numbers use 1
  step?: number
  // the section the control sits in, in every program that has sections
  group?: string
  // a short description, shown as a tooltip where the program has one
  desc?: string
}

export interface Node {
  id: string
  op: string
  in?: Record<string, Wire>
  set?: Record<string, unknown>
}

export interface Graph {
  inoscula: '0.1'
  name: string
  params?: Param[]
  nodes: Node[]
  /** "unlit" (default): color is the final color, identical in every tool. "lit": color is the base color of
   *  a physically based material, and each tool's own renderer lights it (Principled BSDF, Unreal Default Lit,
   *  Godot and Unity standard lit, RICO physical material). */
  shading?: 'unlit' | 'lit'
  /** "solid" (default): alpha blends. "cutout": alpha is cut at 0.5 (fully there or not at all) and both
   *  sides are drawn, for brush stroke cards, leaves and hair cards. */
  surface?: 'solid' | 'cutout'
  /** Brush cards this look is made for (see src/cards.ts): how many strokes, their length as a fraction of
   *  the model's size, and their width as a fraction of their length. Tools that build the cards read it. */
  cards?: { count: number; length: number; width: number; lift?: number }
  /** An outer rim and two offset outlines this look is made for (see src/cards.ts paintShells): how far the rim
   *  and the outlines are inflated, and how far the outlines are shifted, as fractions of the model's size. */
  shells?: { rim: number; outline: number; offset: number }
  output: {
    color: Wire; alpha?: Wire; roughness?: Wire; metallic?: Wire; bump?: Wire; emission?: Wire
    /** Layers on top of the base, as in OpenPBR, Unreal Substrate and Blender's Principled BSDF. */
    coat?: Wire; coat_roughness?: Wire; sheen?: Wire; sheen_color?: Wire; sheen_roughness?: Wire; subsurface?: Wire
    /** An ink outline drawn outside the silhouette (an inflated, inside-out copy of the mesh). Width in meters.
     *  Width and color are a number or color, or a parameter, so every tool can animate them. */
    outline?: Wire; outline_color?: Wire
    /** 0 for a solid line, up to 1 for a broken, hand-inked line (noise eats into it). */
    outline_breakup?: Wire
    /** 0 (default) draws the outline as one band. 1 to 4 turns the band into that many thin, loose lines that
     *  float around the shape at different offsets, like quick pencil passes. A fixed number. */
    outline_rings?: Wire
    /** How far the outline floats off the surface, in meters, leaving a gap between the mesh and the line. 0 (default)
     *  starts it at the surface. The gap is measured as if the shape were round, using its size. */
    outline_offset?: Wire
    /** How many times a second the floating lines and the breakup redraw, like boiling hand-drawn animation. 0
     *  (default) keeps them still. */
    outline_boil?: Wire
    /** Glass: how much of what is behind the surface shows through it, bent by the surface (0 = solid, the
     *  default; 1 = clear glass). Where it is clear, the color comes from the scene behind instead. */
    glass?: Wire
    /** How strongly the glass bends what is behind it, as an index of refraction (1 = not at all, 1.45 by default,
     *  glass is about 1.5, diamond 2.4). */
    ior?: Wire
    /** Splits the bent image into red, green and blue, like a prism (0 = none, the default; 1 = strong). */
    dispersion?: Wire
  }
}

// ---------------------------------------------------------------- node library

type In = [name: string, type: Type | 'T', fallback: Lit]
type Out = Record<string, Type | 'T'>

export interface OpDef {
  ins: In[]
  out: Out
  /** Read only from the engine: positions, normals, time, light. */
  source?: boolean
  doc: string
}

const T = 'T' as const
const one = (t: Type | 'T') => ({ out: t } as Out)

// Every op a graph may use. Generic ops ('T') work on float or vec3; a float wired into a vec3 slot becomes
// (f, f, f), exactly what Blender, Unreal and GLSL all do. A vec3 is never silently squashed into a float.
export const OPS: Record<string, OpDef> = {
  // inputs from the engine (all in canonical space)
  uv: { ins: [], out: one('vec3'), source: true, doc: 'Mesh UV as (u, v, 0), origin bottom left.' },
  object_pos: { ins: [], out: one('vec3'), source: true, doc: 'Position in the object\'s own space. Moves with the object.' },
  world_pos: { ins: [], out: one('vec3'), source: true, doc: 'Position in world space, meters.' },
  normal: { ins: [], out: one('vec3'), source: true, doc: 'World space surface normal.' },
  object_normal: { ins: [], out: one('vec3'), source: true, doc: 'Object space surface normal.' },
  view_dir: { ins: [], out: one('vec3'), source: true, doc: 'World space direction from the surface towards the camera.' },
  time: { ins: [], out: one('float'), source: true, doc: 'Seconds.' },
  light_dir: { ins: [], out: one('vec3'), source: true, doc: 'Lighting contract: world direction towards the main light.' },
  light_color: { ins: [], out: one('vec3'), source: true, doc: 'Lighting contract: main light color.' },
  curvature: { ins: [], out: one('float'), source: true, doc: 'Shape data: 0.5 on flat areas, towards 1 on sharp outer edges, towards 0 in creases. Stored in the mesh (vertex color red) by Inoscula Studio\'s Prepare model.' },
  object_size: { ins: [], out: one('float'), source: true, doc: 'How big the object is, in meters: the diagonal of its bounding box. Lets a look keep the same number of strokes, tiles or spots on any object. RICO: look.fitTo(obj); Blender: the object property inoscula_object_size (the export sets it); Godot: the instance parameter inoscula_object_size (the light bridge sets it); Unreal: Object Radius; Unity: wire the Object node\'s Bounds Size length. 2.0 when unknown.' },
  occlusion: { ins: [], out: one('float'), source: true, doc: 'Shape data: 1 in the open, towards 0 in crevices and contact areas. Stored in the mesh (vertex color green).' },
  param: { ins: [], out: one(T), source: true, doc: 'An exposed, editable parameter. set.id names it.' },
  value: { ins: [], out: one(T), source: true, doc: 'A constant. set.v is a number or [x, y, z].' },

  // maths (float or vec3)
  add: { ins: [['a', T, 0], ['b', T, 0]], out: one(T), doc: 'a + b' },
  sub: { ins: [['a', T, 0], ['b', T, 0]], out: one(T), doc: 'a - b' },
  mul: { ins: [['a', T, 1], ['b', T, 1]], out: one(T), doc: 'a * b, per component.' },
  div: { ins: [['a', T, 0], ['b', T, 1]], out: one(T), doc: 'a / b, and 0 wherever b is 0.' },
  pow: { ins: [['a', T, 0], ['b', T, 1]], out: one(T), doc: 'a to the power b. A negative a with a fractional b gives 0.' },
  min: { ins: [['a', T, 0], ['b', T, 0]], out: one(T), doc: '' },
  max: { ins: [['a', T, 0], ['b', T, 0]], out: one(T), doc: '' },
  clamp: { ins: [['x', T, 0], ['lo', T, 0], ['hi', T, 1]], out: one(T), doc: '' },
  abs: { ins: [['x', T, 0]], out: one(T), doc: '' },
  floor: { ins: [['x', T, 0]], out: one(T), doc: '' },
  fract: { ins: [['x', T, 0]], out: one(T), doc: 'x - floor(x)' },
  sin: { ins: [['x', T, 0]], out: one(T), doc: 'Radians.' },
  cos: { ins: [['x', T, 0]], out: one(T), doc: 'Radians.' },
  one_minus: { ins: [['x', T, 0]], out: one(T), doc: '1 - x' },
  exp: { ins: [['x', T, 0]], out: one(T), doc: 'e to the power x.' },
  sqrt: { ins: [['x', T, 0]], out: one(T), doc: 'Square root. Negative numbers give 0.' },
  log: { ins: [['x', 'float', 1]], out: one('float'), doc: 'Natural logarithm. 0 where x is 0 or less.' },
  mix: { ins: [['a', T, 0], ['b', T, 1], ['t', 'float', 0.5]], out: one(T), doc: 'Blend a to b. t is clamped to 0..1.' },

  // float only
  smoothstep: { ins: [['e0', 'float', 0], ['e1', 'float', 1], ['x', 'float', 0]], out: one('float'), doc: '' },
  greater: { ins: [['a', 'float', 0], ['b', 'float', 0]], out: one('float'), doc: '1 if a > b, else 0.' },
  atan2: { ins: [['y', 'float', 0], ['x', 'float', 1]], out: one('float'), doc: 'Angle of (x, y) in radians, -pi to pi.' },

  // vectors
  dot: { ins: [['a', 'vec3', 0], ['b', 'vec3', 0]], out: one('float'), doc: '' },
  length: { ins: [['x', 'vec3', 0]], out: one('float'), doc: '' },
  normalize: { ins: [['x', 'vec3', 0]], out: one('vec3'), doc: 'Zero stays zero.' },
  combine: { ins: [['x', 'float', 0], ['y', 'float', 0], ['z', 'float', 0]], out: one('vec3'), doc: '' },
  separate: { ins: [['v', 'vec3', 0]], out: { x: 'float', y: 'float', z: 'float' }, doc: '' },

  // pattern and color
  noise: {
    ins: [['p', 'vec3', 0], ['scale', 'float', 5], ['detail', 'float', 2], ['roughness', 'float', 0.5], ['lacunarity', 'float', 2]],
    out: one('float'),
    doc: 'Gradient noise, fractal, 0..1. Bit-for-bit the same maths as Blender\'s Noise Texture (3D, fBM, normalized).',
  },
  white_noise: {
    ins: [['p', 'vec3', 0]],
    out: one('float'),
    doc: 'A random number 0..1 for each exact point. Use floor() first for cells, flicker or grain that holds still. Same hash as Blender\'s White Noise Texture.',
  },
  voronoi: {
    ins: [['p', 'vec3', 0], ['scale', 'float', 5], ['randomness', 'float', 1]],
    out: { out: 'float', color: 'vec3', position: 'vec3' },
    doc: 'Cells. Main output: distance to the nearest cell point (F1, Euclidean). .color: a random color per cell. .position: the cell point. Same maths as Blender\'s Voronoi Texture (3D, F1, Euclidean).',
  },
  ramp: {
    ins: [['t', 'float', 0.5]],
    out: one('vec3'),
    doc: 'Color ramp. set.mode is "linear" or "constant", set.stops is [[position, [r, g, b]], ...].',
  },
}

// ---------------------------------------------------------------- the checked graph (IR)

export type Arg = { k: 'ref'; id: string; type: Type } | { k: 'lit'; v: Lit; type: Type }

export interface Step {
  id: string // variable name, unique
  node: string // graph node id
  op: string
  args: Arg[] // in OpDef.ins order, already promoted to the right type
  type: Type // of the main output
  outs: Record<string, Type>
  set: Record<string, unknown>
}

export interface IR {
  name: string
  params: (Param & { t: Type })[]
  steps: Step[]
  color: Arg
  alpha: Arg | null
  lit: boolean
  /** Alpha cut at 0.5, both sides drawn. */
  cutout: boolean
  roughness: Arg
  metallic: Arg
  bump: Arg | null
  emission: Arg | null
  /** Optional layers, null when unused. */
  /** The graph this came from, so every export can carry it and be read back. */
  source: Graph
  outline: { width: Arg; color: Arg; breakup: Arg; rings: number; offset: Arg; boil: Arg } | null
  /** Glass (see Graph.output.glass), null when unused. */
  glass: { amount: Arg; ior: Arg; dispersion: Arg } | null
  layers: { coat: Arg | null; coat_roughness: Arg | null; sheen: Arg | null; sheen_color: Arg | null; sheen_roughness: Arg | null; subsurface: Arg | null }
  uses: Set<string> // source ops used, so targets only declare what they need
}

export class InosculaError extends Error {}

const isVec = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number')
export const safeId = (s: string) => {
  const id = s.replace(/[^A-Za-z0-9_]/g, '_').replace(/^([0-9])/, '_$1')
  return id || '_'
}

// a parameter's tooltip: its own description, and what each number means for an on/off switch or a list
export function paramDesc(p: { desc?: string; ui?: string; options?: string[] }) {
  const what = p.ui === 'toggle' ? '0 = off, 1 = on' : p.ui === 'menu' && p.options ? p.options.map((o, i) => `${i} = ${o}`).join(', ') : ''
  return [p.desc, what].filter(Boolean).join('. ')
}
export function check(g: Graph): IR {
  if (g.inoscula !== '0.1') throw new InosculaError(`Unknown format version "${g.inoscula}". This reader understands 0.1.`)
  const params = (g.params ?? []).map((p) => {
    const t: Type = p.type === 'float' ? 'float' : 'vec3'
    if (t === 'vec3' ? !isVec(p.default) : typeof p.default !== 'number') throw new InosculaError(`Parameter "${p.id}" has the wrong kind of default.`)
    return { ...p, id: safeId(p.id), t }
  })
  const paramT = new Map(params.map((p) => [p.id, p.t]))
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  if (byId.size !== g.nodes.length) throw new InosculaError('Two nodes share an id.')

  const steps: Step[] = []
  const done = new Map<string, Step>()
  const visiting = new Set<string>()
  const uses = new Set<string>()
  let n = 0

  const litType = (v: Lit): Type => (typeof v === 'number' ? 'float' : 'vec3')

  function wire(w: Wire, where: string): Arg {
    if (typeof w === 'number' || isVec(w)) return { k: 'lit', v: w, type: litType(w) }
    if (typeof w !== 'string') throw new InosculaError(`${where}: cannot read this wire.`)
    if (w.startsWith('$')) {
      const t = paramT.get(safeId(w.slice(1)))
      if (!t) throw new InosculaError(`${where}: no parameter called "${w.slice(1)}".`)
      uses.add('param')
      return { k: 'ref', id: 'p_' + safeId(w.slice(1)), type: t }
    }
    const [nid, port] = w.split('.')
    const s = visit(nid, where)
    if (!port || port === 'out') return { k: 'ref', id: s.id, type: s.type }
    const t = s.outs[port]
    if (!t) throw new InosculaError(`${where}: node "${nid}" has no output "${port}".`)
    return { k: 'ref', id: `${s.id}_${port}`, type: t }
  }

  function promote(a: Arg, want: Type, where: string): Arg {
    if (a.type === want) return a
    if (a.type === 'float' && want === 'vec3') return { ...a, type: 'vec3', ...(a.k === 'lit' ? { v: [a.v, a.v, a.v] as Lit } : {}) } as Arg
    throw new InosculaError(`${where}: a vector cannot go into a single number. Use a "separate" node to pick x, y or z.`)
  }

  function visit(id: string, from: string): Step {
    const got = done.get(id)
    if (got) return got
    const node = byId.get(id)
    if (!node) throw new InosculaError(`${from}: no node called "${id}".`)
    if (visiting.has(id)) throw new InosculaError(`Node "${id}" feeds back into itself.`)
    visiting.add(id)
    const def = OPS[node.op]
    if (!def) throw new InosculaError(`Node "${id}" uses "${node.op}", which this version does not know.`)
    const set = node.set ?? {}
    const where = `Node "${id}" (${node.op})`
    let args = def.ins.map(([name, , fb]) => wire(node.in?.[name] ?? fb, `${where}, input "${name}"`))
    for (const k of Object.keys(node.in ?? {})) if (!def.ins.some(([nm]) => nm === k)) throw new InosculaError(`${where} has no input "${k}".`)

    // decide T
    let T: Type = 'float'
    if (node.op === 'param') {
      const t = paramT.get(safeId(String(set.id)))
      if (!t) throw new InosculaError(`${where}: no parameter called "${set.id}".`)
      T = t
    } else if (node.op === 'value') {
      if (typeof set.v !== 'number' && !isVec(set.v)) throw new InosculaError(`${where}: set.v must be a number or [x, y, z].`)
      T = litType(set.v as Lit)
    } else if (def.ins.some(([nm, t], i) => t === 'T' && args[i].type === 'vec3')) T = 'vec3'
    args = args.map((a, i) => {
      const want = def.ins[i][1]
      return promote(a, want === 'T' ? T : want, `${where}, input "${def.ins[i][0]}"`)
    })
    if (node.op === 'ramp') checkRamp(set, where)
    if (def.source) uses.add(node.op)
    if (node.op === 'noise' || node.op === 'white_noise' || node.op === 'voronoi') uses.add('hash')
    if (node.op === 'voronoi') uses.add('voronoi')
    if (node.op === 'noise') uses.add('noise')

    const outs: Record<string, Type> = {}
    for (const [k, t] of Object.entries(def.out)) outs[k] = t === 'T' ? T : t
    const step: Step = { id: `v${n++}`, node: id, op: node.op, args, type: outs.out ?? 'float', outs, set }
    if (node.op === 'param') step.id = 'p_' + safeId(String(set.id))
    visiting.delete(id)
    done.set(id, step)
    if (node.op !== 'param') steps.push(step)
    return step
  }

  const color = promote(wire(g.output.color, 'Output color'), 'vec3', 'Output color')
  let alpha = g.output.alpha === undefined ? null : promote(wire(g.output.alpha, 'Output alpha'), 'float', 'Output alpha')
  if (alpha?.k === 'lit' && alpha.v === 1) alpha = null
  const o = g.output
  const litKeys = ['roughness', 'metallic', 'bump', 'emission', 'coat', 'coat_roughness', 'sheen', 'sheen_color', 'sheen_roughness', 'subsurface'] as const
  const anyLit = litKeys.some((k) => o[k] !== undefined)
  const lit = g.shading === 'lit' || (g.shading === undefined && anyLit)
  if (!lit && anyLit) throw new InosculaError('Roughness, metallic, bump, emission and the coat, sheen and subsurface layers need lit shading. Set "shading": "lit".')
  const opt = (w: Wire | undefined, t: Type, what: string) => (w === undefined ? null : promote(wire(w, what), t, what))
  const roughness = opt(o.roughness, 'float', 'Output roughness') ?? { k: 'lit', v: 0.5, type: 'float' }
  const metallic = opt(o.metallic, 'float', 'Output metallic') ?? { k: 'lit', v: 0, type: 'float' }
  const bump = opt(o.bump, 'float', 'Output bump')
  const emission = opt(o.emission, 'vec3', 'Output emission')
  const layers = {
    coat: opt(o.coat, 'float', 'Output coat'), coat_roughness: opt(o.coat_roughness, 'float', 'Output coat roughness'),
    sheen: opt(o.sheen, 'float', 'Output sheen'), sheen_color: opt(o.sheen_color, 'vec3', 'Output sheen color'),
    sheen_roughness: opt(o.sheen_roughness, 'float', 'Output sheen roughness'), subsurface: opt(o.subsurface, 'float', 'Output subsurface'),
  }
  let outline: IR['outline'] = null
  if (o.outline !== undefined) {
    const width = promote(wire(o.outline, 'Outline width'), 'float', 'Outline width')
    const ocol = o.outline_color === undefined ? { k: 'lit', v: [0.02, 0.02, 0.03], type: 'vec3' } as Arg : promote(wire(o.outline_color, 'Outline color'), 'vec3', 'Outline color')
    const breakup = o.outline_breakup === undefined ? { k: 'lit', v: 0, type: 'float' } as Arg : promote(wire(o.outline_breakup, 'Outline breakup'), 'float', 'Outline breakup')
    const offset = o.outline_offset === undefined ? { k: 'lit', v: 0, type: 'float' } as Arg : promote(wire(o.outline_offset, 'Outline offset'), 'float', 'Outline offset')
    const boil = o.outline_boil === undefined ? { k: 'lit', v: 0, type: 'float' } as Arg : promote(wire(o.outline_boil, 'Outline boil'), 'float', 'Outline boil')
    for (const [a, what] of [[width, 'outline'], [ocol, 'outline_color'], [breakup, 'outline_breakup'], [offset, 'outline_offset'], [boil, 'outline_boil']] as const) {
      if (a.k === 'ref' && !a.id.startsWith('p_')) throw new InosculaError(`${what} must be a fixed value or a parameter (it sets a modifier or a second pass, which cannot change across the surface). Make it a uniform.`)
    }
    let rings = 0
    if (o.outline_rings !== undefined) {
      if (typeof o.outline_rings !== 'number') throw new InosculaError('outline_rings must be a plain number (0 to 4).')
      rings = Math.max(0, Math.min(4, Math.round(o.outline_rings)))
    }
    outline = { width, color: ocol, breakup, rings, offset, boil }
  }
  let glass: IR['glass'] = null
  if (o.glass !== undefined) {
    const amount = promote(wire(o.glass, 'Output glass'), 'float', 'Output glass')
    if (!(amount.k === 'lit' && amount.v === 0)) {
      const ior = o.ior === undefined ? { k: 'lit', v: 1.45, type: 'float' } as Arg : promote(wire(o.ior, 'Output ior'), 'float', 'Output ior')
      const dispersion = o.dispersion === undefined ? { k: 'lit', v: 0, type: 'float' } as Arg : promote(wire(o.dispersion, 'Output dispersion'), 'float', 'Output dispersion')
      glass = { amount, ior, dispersion }
    }
  } else if (o.ior !== undefined || o.dispersion !== undefined) throw new InosculaError('ior and dispersion only do something on glass. Set "glass = ..." too.')
  if (glass && g.surface === 'cutout') throw new InosculaError('Glass and a cutout surface do not go together. Use alpha for holes, or drop the cutout.')
  return { name: g.name, params, steps, color, alpha, uses, lit, cutout: g.surface === 'cutout', roughness, metallic, bump, emission, layers, outline, glass, source: g }
}

function checkRamp(set: Record<string, unknown>, where: string) {
  const stops = set.stops
  if (!Array.isArray(stops) || stops.length < 1 || stops.length > 32) throw new InosculaError(`${where}: set.stops needs 1 to 32 stops.`)
  let last = -Infinity
  for (const s of stops) {
    if (!Array.isArray(s) || typeof s[0] !== 'number' || !isVec(s[1])) throw new InosculaError(`${where}: each stop is [position, [r, g, b]].`)
    if (s[0] < last) throw new InosculaError(`${where}: stops must be in order.`)
    last = s[0]
  }
  if (set.mode !== 'linear' && set.mode !== 'constant') throw new InosculaError(`${where}: set.mode is "linear" or "constant".`)
}

export const rampStops = (set: Record<string, unknown>) => set.stops as [number, [number, number, number]][]
