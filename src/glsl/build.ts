// Building Inoscula nodes from single numbers. Every GLSL value is kept as a list of parts (a vec4 is 4 parts),
// and each part is a fixed number, a float wire, or one part of a vec3 wire. Maths on whole vectors is grouped
// back into vec3 nodes, so the node graph stays close to what a person would build.
import { OPS, type Node, type Wire } from '../spec.ts'
import { CodeError } from '../lang.ts'

export type Sym = { f: string } | { v: string; i: number }
export type S = number | Sym

export const NODE_LIMIT = 30000

const f32 = Math.fround
const safePow = (a: number, b: number) => (a < 0 && b !== Math.floor(b) ? 0 : Math.pow(a, b))
// the same rules as the Inoscula ops, so a folded number is what the node would give
const CONST_FOLD: Record<string, (...x: number[]) => number> = {
  add: (a, b) => a + b, sub: (a, b) => a - b, mul: (a, b) => a * b, div: (a, b) => (b === 0 ? 0 : a / b),
  pow: safePow, min: Math.min, max: Math.max, clamp: (x, lo, hi) => Math.min(Math.max(x, lo), hi),
  abs: Math.abs, floor: Math.floor, fract: (x) => x - Math.floor(x), sin: Math.sin, cos: Math.cos, one_minus: (x) => 1 - x,
  exp: Math.exp, sqrt: (x) => (x < 0 ? 0 : Math.sqrt(x)), log: (x) => (x <= 0 ? 0 : Math.log(x)),
  mix: (a, b, t) => { const u = Math.min(Math.max(t, 0), 1); return a + (b - a) * u },
  smoothstep: (e0, e1, x) => { if (e0 === e1) return x < e0 ? 0 : 1; const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t) },
  greater: (a, b) => (a > b ? 1 : 0), atan2: Math.atan2,
}
const INS: Record<string, string[]> = Object.fromEntries(Object.entries(OPS).map(([k, d]) => [k, d.ins.map((x) => x[0])]))
INS.log = ['x']

export const key = (s: S): string => (typeof s === 'number' ? 'n' + s : 'f' in s ? s.f : s.v + '#' + s.i)
export const same = (a: S, b: S) => key(a) === key(b)

export class Builder {
  nodes: Node[] = []
  lineOf = new Map<string, number>()
  line = 0
  private types = new Map<string, 'float' | 'vec3'>()
  private cse = new Map<string, string>()
  private seps = new Map<string, string>()
  private byId = new Map<string, Node>()
  private zz = new Set<string>() // vec3 wires whose third part is known to be 0
  ranges = new Map<string, [number, number]>()
  unit = (s: S) => { const r = this.range(s); return r[0] >= 0 && r[1] <= 1 }
  private count = 0

  wireType(w: Wire): 'float' | 'vec3' {
    if (typeof w === 'number') return 'float'
    if (Array.isArray(w)) return 'vec3'
    return this.types.get(w) ?? 'float'
  }
  setType(w: string, t: 'float' | 'vec3') { this.types.set(w, t) }
  markZ(w: string) { this.zz.add(w) }
  zeroZ(w: Wire) { return Array.isArray(w) ? w[2] === 0 : typeof w === 'string' && this.zz.has(w) }

  range(s: S): [number, number] {
    if (typeof s === 'number') return [s, s]
    return this.ranges.get(key(s)) ?? [-Infinity, Infinity]
  }

  node(op: string, ins: Record<string, Wire>, out: 'float' | 'vec3', set?: Record<string, unknown>, base = op): string {
    const k = op + JSON.stringify(ins) + (set ? JSON.stringify(set) : '')
    const hit = this.cse.get(k)
    if (hit) return hit
    if (++this.count > NODE_LIMIT) throw new CodeError(`this shader is too big to turn into nodes (over ${NODE_LIMIT.toLocaleString('en-US')} nodes). Lower the number of steps in the loops above this line, or the number of samples, and try again.`, this.line)
    const id = `${base}_${this.count}`
    const n: Node = { id, op }
    if (Object.keys(ins).length) n.in = ins
    if (set) n.set = set
    this.nodes.push(n)
    this.byId.set(id, n)
    this.lineOf.set(id, this.line)
    this.cse.set(k, id)
    this.types.set(id, out)
    return id
  }
  source(op: string, out: 'float' | 'vec3') { return this.node(op, {}, out, undefined, op) }

  /** A float wire for one part. */
  fw(s: S): Wire {
    if (typeof s === 'number') return f32(s)
    if ('f' in s) return s.f
    let sep = this.seps.get(s.v)
    if (!sep) { sep = this.node('separate', { v: s.v }, 'float', undefined, 'parts'); this.seps.set(s.v, sep) }
    const port = `${sep}.${'xyz'[s.i]}`
    this.types.set(port, 'float')
    return port
  }
  /** A vec3 wire for up to three parts. With strict, a missing third part is 0 (needed for dot, length and normalize). */
  v3(c: S[], strict = false): Wire {
    const p = [c[0], c[1] ?? 0, c[2] ?? 0]
    if (p.every((x) => typeof x === 'number')) return p.map((x) => f32(x as number)) as [number, number, number]
    const a = p[0], b = p[1]
    if (typeof a !== 'number' && 'v' in a && a.i === 0 && typeof b !== 'number' && 'v' in b && b.v === a.v && b.i === 1) {
      const z = p[2]
      if (c.length === 3 && typeof z !== 'number' && 'v' in z && z.v === a.v && z.i === 2) return a.v
      if (c.length === 2 && (!strict || this.zeroZ(a.v))) return a.v
      if (c.length < 3 && strict && z === 0 && this.zeroZ(a.v)) return a.v
    }
    if (c.length === 3 && same(p[0], p[1]) && same(p[1], p[2])) return this.fw(p[0])
    const id = this.node('combine', { x: this.fw(p[0]), y: this.fw(p[1]), z: this.fw(p[2]) }, 'vec3', undefined, 'vec')
    if (p[2] === 0) this.zz.add(id)
    return id
  }
  parts(w: Wire, n: number): S[] {
    if (typeof w === 'number') return Array(n).fill(w)
    if (Array.isArray(w)) return w.slice(0, n)
    if (this.wireType(w) === 'float') return Array(n).fill({ f: w })
    return Array.from({ length: n }, (_, i) => ({ v: w, i }))
  }

  /** One float op. Folds numbers and the easy cases (x + 0, x * 1...). */
  s(op: string, ...a: S[]): S {
    if (a.every((x) => typeof x === 'number') && CONST_FOLD[op]) return f32(CONST_FOLD[op](...(a as number[])))
    const [x, y] = a
    switch (op) {
      case 'add': if (x === 0) return y; if (y === 0) return x; break
      case 'sub': if (y === 0) return x; if (same(x, y)) return 0; break
      case 'mul': if (x === 1) return y; if (y === 1) return x; if (x === 0 || y === 0) return 0; break
      case 'div': if (y === 1) return x; break
      case 'pow': if (y === 1) return x; if (y === 0) return 1; break
      case 'min': case 'max': if (same(x, y)) return x; break
      case 'mix': { const t = a[2]; if (same(x, y)) return x; if (typeof t === 'number' && t <= 0) return x; if (typeof t === 'number' && t >= 1) return y; break }
    }
    // ranges: comparisons settle when the two sides cannot overlap
    if (op === 'greater') { const ra = this.range(x), rb = this.range(y); if (ra[0] > rb[1]) return 1; if (ra[1] <= rb[0]) return 0 }
    if (op === 'one_minus' && typeof x !== 'number' && 'f' in x) {
      const n = this.byId.get(x.f); if (n?.op === 'one_minus') return this.parts(n.in!.x, 1)[0]
    }
    if (op === 'clamp') { const r = this.range(x); if (typeof a[1] === 'number' && typeof a[2] === 'number' && r[0] >= a[1] && r[1] <= a[2]) return x }
    const ins: Record<string, Wire> = {}
    INS[op].forEach((nm, i) => { if (i < a.length) ins[nm] = this.fw(a[i]) })
    const id = this.node(op, ins, 'float')
    const out: S = { f: id }
    const r = this.rangeOf(op, a)
    if (r) this.ranges.set(id, r)
    return out
  }
  private rangeOf(op: string, a: S[]): [number, number] | null {
    const R = a.map((x) => this.range(x))
    switch (op) {
      case 'greater': case 'smoothstep': case 'fract': return [0, 1]
      case 'sin': case 'cos': return [-1, 1]
      case 'one_minus': return [1 - R[0][1], 1 - R[0][0]]
      case 'add': return [R[0][0] + R[1][0], R[0][1] + R[1][1]]
      case 'sub': return [R[0][0] - R[1][1], R[0][1] - R[1][0]]
      case 'mul': { const p = [R[0][0] * R[1][0], R[0][0] * R[1][1], R[0][1] * R[1][0], R[0][1] * R[1][1]].map((v) => (isNaN(v) ? 0 : v)); return [Math.min(...p), Math.max(...p)] }
      case 'min': return [Math.min(R[0][0], R[1][0]), Math.min(R[0][1], R[1][1])]
      case 'max': return [Math.max(R[0][0], R[1][0]), Math.max(R[0][1], R[1][1])]
      case 'clamp': return [Math.max(R[0][0], R[1][0]), Math.min(Math.max(R[0][1], R[1][0]), R[2][1])]
      case 'abs': return [R[0][0] <= 0 && R[0][1] >= 0 ? 0 : Math.min(Math.abs(R[0][0]), Math.abs(R[0][1])), Math.max(Math.abs(R[0][0]), Math.abs(R[0][1]))]
      case 'floor': return [Math.floor(R[0][0]), Math.floor(R[0][1])]
      case 'sqrt': return [0, Math.sqrt(Math.max(0, R[0][1]))]
      case 'exp': return [0, Math.exp(R[0][1])]
      case 'mix': return [Math.min(R[0][0], R[1][0]), Math.max(R[0][1], R[1][1])]
    }
    return null
  }

  /** The same op on every part, in groups of three. a and b may be a single part (used for every part). */
  ew(op: string, ...args: S[][]): S[] {
    const n = Math.max(...args.map((x) => x.length))
    const at = (x: S[], i: number) => (x.length === 1 ? x[0] : x[i])
    const floatOnly = !(op in OPS) || OPS[op].ins.some((x) => x[1] === 'float') && op !== 'mix'
    const out: S[] = []
    for (let s = 0; s < n; s += 3) {
      const k = Math.min(3, n - s)
      const chunk = args.map((x) => (x.length === 1 ? [x[0]] : x.slice(s, s + k)))
      const uniform = chunk.every((c) => c.every((y) => same(y, c[0])))
      if (k === 1 || floatOnly || uniform || chunk.every((c) => c.every((y) => typeof y === 'number'))) {
        if (uniform && !floatOnly) { const r = this.s(op, ...chunk.map((c) => c[0])); for (let i = 0; i < k; i++) out.push(r); continue }
        for (let i = 0; i < k; i++) out.push(this.s(op, ...args.map((x) => at(x, s + i))))
        continue
      }
      // fold the easy cases on whole groups
      const allNum = (c: S[], v: number) => c.every((y) => y === v)
      const [A, B] = chunk
      if ((op === 'add' && allNum(B, 0)) || (op === 'sub' && allNum(B, 0)) || (op === 'mul' && allNum(B, 1)) || (op === 'div' && allNum(B, 1))) { out.push(...A.length === 1 ? Array(k).fill(A[0]) : A); continue }
      if (op === 'add' && allNum(A, 0) || op === 'mul' && allNum(A, 1)) { out.push(...B.length === 1 ? Array(k).fill(B[0]) : B); continue }
      if (op === 'mul' && (allNum(A, 0) || allNum(B, 0))) { out.push(...Array(k).fill(0)); continue }
      const ins: Record<string, Wire> = {}
      const names = INS[op]
      const wires = chunk.map((c) => (c.length === 1 ? this.fw(c[0]) : this.v3(c)))
      names.forEach((nm, i) => { if (i < wires.length) ins[nm] = wires[i] })
      // a / (a * b) style: undo a multiply by the same fixed vector (fragCoord / iResolution)
      if (op === 'div' && typeof wires[0] === 'string' && Array.isArray(wires[1])) {
        const m = this.byId.get(wires[0])
        if (m?.op === 'mul' && JSON.stringify(m.in!.b) === JSON.stringify(wires[1])) {
          const src = m.in!.a
          for (let i = 0; i < k; i++) out.push(this.parts(src, 3)[i])
          continue
        }
      }
      const id = this.node(op, ins, 'vec3')
      const keeps = ['add', 'sub', 'min', 'max', 'mix'].includes(op) ? wires.slice(0, 2).every((w) => this.zeroZ(w))
        : op === 'mul' ? wires.slice(0, 2).some((w) => this.zeroZ(w))
          : ['div', 'abs', 'floor', 'fract', 'sin', 'sqrt', 'normalize'].includes(op) && this.zeroZ(wires[0])
      if (keeps) this.zz.add(id)
      for (let i = 0; i < k; i++) out.push({ v: id, i })
    }
    return out
  }
  /** a vec3 op on a whole vector (dot, length, normalize), with the parts after the third set to 0 */
  vec(op: string, ...args: S[][]): string {
    const ins: Record<string, Wire> = {}
    INS[op].forEach((nm, i) => { if (i < args.length) ins[nm] = this.v3(args[i], true) })
    return this.node(op, ins, OPS[op]?.out[Object.keys(OPS[op].out)[0]] === 'vec3' ? 'vec3' : 'float')
  }
}
