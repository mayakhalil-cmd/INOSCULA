// Running a GLSL shader on symbols instead of numbers. Every value becomes nodes; loops are written out step by
// step; if, break, continue and return become masks (1 where that code runs, 0 where it does not), so each
// variable ends up as a blend of what every branch would have left in it. That is exactly what a GPU does with
// branches that differ per pixel, so the nodes give the same picture as the original shader.
import { Builder, key, same, type S } from './build.ts'
import { CodeError } from '../lang.ts'
import type { Expr, Fn, Stmt, TypeName, StructDef } from './parse.ts'
import { numValue, isIntLit } from './pre.ts'
import { F, I, B, vec, size, show, basic, eqTy, type Ty, type Base } from './types.ts'

export type Val = { t: Ty; c: S[] }
// view: what the variable holds for the pixels in mask m (and every mask inside it), when that is simpler than
// the blend kept in c. A loop counter stays a plain number for the pixels still looping, even after others break.
const BOUND = 1e19 // still finite when squared

export type Var = { t: Ty; c: S[]; base: string; isConst?: boolean; name: string; view?: { m: string; c: S[] } }
type Loop = { out: S; cont: S; sw: boolean }
type Frame = { ret: Var; retTy: Ty; name: string }
type LVal = { v: Var; alts: { c: S; idx: number[] }[]; t: Ty }

const MAX_SYMBOLIC_STEPS = 128 // passes through a loop whose end depends on the picture
const MAX_STEPS = 4096 // passes through any one loop
const MAX_WORK = 400000 // statements run in total

export const HASH_HELP = 'Nodes work with ordinary numbers, so integer bit tricks (often used for random numbers) cannot be built. For a random number use white_noise(p), which gives a number from 0 to 1. Inside a function that returns the random number, this swap is made for you.'
const SWZ = ['xyzw', 'rgba', 'stpq']

function notDefined(n: string): string {
  if (/^iChannel(\d|Resolution|Time)/.test(n)) return `"${n}" is one of Shadertoy's channel inputs: a picture, video, sound or another buffer picked under the code. A material made of nodes cannot read those, so remove the lines that use ${n}, or put a pattern such as noise(p) in their place.`
  if (/^(gl_Position|gl_PointSize|gl_Vertex|gl_VertexID|gl_InstanceID)$/.test(n)) return `this is a vertex shader (it sets ${n}, which moves the points of a mesh). Inoscula reads the other half, the fragment shader, which sets the color of each pixel. In three.js that is the fragmentShader text; on Shadertoy it is the code with mainImage.`
  if (n === 'iSampleRate') return 'iSampleRate belongs to Shadertoy sound shaders, which make audio, not a picture.'
  return `"${n}" is not defined. Declare it first, for example: float ${n} = 0.0;`
}

export class Eval {
  b = new Builder()
  structs = new Map<string, Ty>()
  fns = new Map<string, Fn[]>()
  globals = new Map<string, Var>()
  scopes: Map<string, Var>[] = [this.globals]
  mask: S = 1
  kills = 0
  loops: Loop[] = []
  frames: Frame[] = []
  discard: S = 0
  calling: string[] = []
  work = 0
  warnings: { line: number; msg: string }[] = []
  /** names the shader reads without declaring them: shader inputs such as iTime or uv */
  builtin: (name: string, e: Expr) => Val | undefined = () => undefined
  /** names the shader writes without declaring them: outputs such as color or gl_FragColor */
  output: (name: string, e: Expr) => Var | undefined = () => undefined
  /** Inoscula's own pattern functions, used when the shader does not define a function by that name */
  extra: (name: string, a: Val[], e: Expr) => Val | undefined = () => undefined

  err(msg: string, at: { line: number; col?: number }): never { throw new CodeError(msg, at.line, at.col ?? 0) }
  warn(line: number, msg: string) { if (!this.warnings.some((w) => w.msg === msg)) this.warnings.push({ line, msg }) }

  // ---------------------------------------------------------------- masks
  parent = new Map<string, string>() // mask -> the mask it was cut from
  and(a: S, b: S): S {
    const r = this.b.s('mul', a, b)
    if (typeof r !== 'number' && !same(r, a)) this.parent.set(key(r), key(a))
    return r
  }
  read(v: Var): S[] {
    if (!v.view) return v.c
    // only settled numbers are taken from the view (loop counters and the like). Anything else is read through
    // the select, so pixels that stopped keep their last value instead of running on until it overflows.
    for (let k: string | undefined = key(this.mask); k; k = this.parent.get(k)) {
      if (k === v.view.m) return v.c.map((x, i) => (typeof v.view!.c[i] === 'number' ? v.view!.c[i] : x))
    }
    return v.c
  }
  not(a: S): S { return this.b.s('one_minus', a) }
  or(a: S, b: S): S { return this.b.s('add', a, b) } // only for masks that never overlap
  sel(m: S, a: S[], b: S[]): S[] {
    if (m === 1) return a
    if (m === 0) return b
    const out = b.slice()
    const idx: number[] = []
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) idx.push(i)
    if (!idx.length) return out
    // a side that is not picked still counts: infinity times zero is NaN. Huge values are held to a finite
    // bound first, unless they are known to be small already.
    const bound = (x: S[]) => {
      const big = x.map((y) => { const r = this.b.range(y); return !(r[0] >= -BOUND && r[1] <= BOUND) })
      if (!big.some(Boolean)) return x
      const c = this.b.ew('clamp', x, [-BOUND], [BOUND])
      return x.map((y, i) => (big[i] ? c[i] : y))
    }
    const r = this.b.ew('mix', bound(idx.map((i) => b[i])), bound(idx.map((i) => a[i])), [m])
    idx.forEach((i, k) => { out[i] = r[k] })
    return out
  }

  // ---------------------------------------------------------------- types and variables
  type(tn: TypeName, at: { line: number }): Ty {
    let t = basic(tn.name) ?? this.structs.get(tn.name)
    if (!t) this.err(`"${tn.name}" is not a type.`, at)
    for (let i = tn.arr.length - 1; i >= 0; i--) t = this.arrOf(t!, tn.arr[i], at)
    return t!
  }
  arrOf(t: Ty, dim: Expr | null, at: { line: number }): Ty {
    if (dim === null) return { k: 'arr', of: t, len: -1 }
    const n = this.eval(dim).c[0]
    if (typeof n !== 'number') this.err('the size of an array must be a fixed number.', at)
    return { k: 'arr', of: t, len: n as number }
  }
  struct(s: StructDef) {
    const fields = s.fields.map((f) => ({ name: f.name, t: this.type(f.type, s) }))
    this.structs.set(s.name, { k: 'struct', name: s.name, fields })
  }
  zero(t: Ty): S[] { return Array(size(t)).fill(0) }
  lookup(name: string): Var | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) { const v = this.scopes[i].get(name); if (v) return v }
    return undefined
  }
  declare(name: string, t: Ty, c: S[], isConst = false): Var {
    const v: Var = { t, c, base: key(this.mask), isConst, name }
    this.scopes[this.scopes.length - 1].set(name, v)
    return v
  }
  write(v: Var, idx: number[], c: S[], cond: S = 1) {
    const m = this.and(this.mask, cond)
    if (m === 0) return
    if (cond === 1 && key(this.mask) === v.base) { idx.forEach((j, i) => { v.c[j] = c[i] }); v.view = undefined; return }
    const seen = this.read(v).slice()
    const r = this.sel(m, c, idx.map((j) => v.c[j]))
    idx.forEach((j, i) => { v.c[j] = r[i] })
    if (cond === 1) { idx.forEach((j, i) => { seen[j] = c[i] }); v.view = { m: key(this.mask), c: seen } }
    else v.view = undefined
  }

  /** a value turned into another type, as GLSL does on assignment (and a little more, so near-miss code still works) */
  conv(v: Val, t: Ty, at: { line: number; col?: number }, what = 'this value'): Val {
    if (eqTy(v.t, t)) return v
    if (t.k === 'arr' && v.t.k === 'arr' && t.len === -1 && eqTy(t.of, v.t.of)) return v
    if (t.k === 'num' && v.t.k === 'num') {
      if (v.t.n === t.n) return { t, c: this.toBase(v.c, v.t.b, t.b) }
      if (v.t.n === 1) return { t, c: Array(t.n).fill(this.toBase(v.c, v.t.b, t.b)[0]) }
      this.err(`${what} is a ${show(v.t)}, but a ${show(t)} is needed here.${v.t.n > t.n ? ` Pick the parts you need, for example .${'xyzw'.slice(0, t.n)}.` : ''}`, at)
    }
    if (t.k === 'mat' && v.t.k === 'mat') return this.ctor(t, [v], at)
    return this.err(`${what} is a ${show(v.t)}, but a ${show(t)} is needed here.`, at)
  }
  toBase(c: S[], from: Base, to: Base): S[] {
    if (from === to || to === 'float' || (from !== 'float' && to !== 'bool')) return c
    if (to === 'bool') return c.map((x) => this.ne(x, 0))
    return c.map((x) => this.trunc(x)) // float to int
  }
  trunc(x: S): S {
    if (typeof x === 'number') return Math.trunc(x)
    const r = this.b.range(x)
    if (r[0] >= 0) return this.b.s('floor', x)
    const s = this.b.s('sub', this.b.s('greater', x, 0), this.b.s('greater', 0, x))
    return this.b.s('mul', s, this.b.s('floor', this.b.s('abs', x)))
  }
  eq(a: S, b: S): S { return this.not(this.b.s('greater', this.b.s('abs', this.b.s('sub', a, b)), 0)) }
  ne(a: S, b: S): S { return this.b.s('greater', this.b.s('abs', this.b.s('sub', a, b)), 0) }
  // used for whole numbers (array positions, switch cases), where a little slack is safe
  eqInt(a: S, b: S): S { return this.not(this.b.s('greater', this.b.s('abs', this.b.s('sub', a, b)), 0.5)) }

  // ---------------------------------------------------------------- expressions
  eval(e: Expr): Val {
    this.b.line = e.line
    switch (e.k) {
      case 'num': { const v = numValue(e.v); if (!isFinite(v)) this.err(`"${e.v}" is not a number GLSL can hold.`, e); return { t: isIntLit(e.v) ? (/[uU]$/.test(e.v) ? { k: 'num', b: 'uint', n: 1 } : I) : F, c: [v] } }
      case 'id': {
        const v = this.lookup(e.name)
        if (v) return { t: v.t, c: this.read(v).slice() }
        const bi = this.builtin(e.name, e)
        if (bi) return bi
        if (this.fns.has(e.name)) this.err(`${e.name} is a function, so it needs brackets: ${e.name}(...).`, e)
        return this.err(notDefined(e.name), e)
      }
      case 'seq': { let v: Val = { t: { k: 'void' }, c: [] }; for (const x of e.list) v = this.eval(x); return v }
      case 'init': return this.err('a { ... } list can only be used to set up a variable, for example: float a[3] = { 1.0, 2.0, 3.0 };', e)
      case 'cond': {
        const c = this.cond(this.eval(e.c), e.c)
        if (c === 1) return this.eval(e.a)
        if (c === 0) return this.eval(e.b)
        const a = this.eval(e.a), b = this.eval(e.b)
        const t = this.common(a.t, b.t, e)
        return { t, c: this.sel(c, this.conv(a, t, e).c, this.conv(b, t, e).c) }
      }
      case 'un': {
        if (e.op === '++' || e.op === '--') {
          const L = this.lval(e.a)
          const old = this.readL(L)
          const nv = this.arith(e.op === '++' ? '+' : '-', old, { t: I, c: [1] }, e)
          this.writeL(L, this.conv(nv, L.t, e).c)
          return nv
        }
        const a = this.eval(e.a)
        if (e.op === '+') return a
        if (e.op === '-') return { t: a.t, c: this.b.ew('mul', a.c, [-1]) }
        if (e.op === '!') return { t: a.t, c: a.c.map((x) => this.not(x)) }
        if (e.op === '~') return { t: a.t, c: a.c.map((x) => (typeof x === 'number' ? ~x : this.err(HASH_HELP, e))) }
        return this.err(`"${e.op}" is not understood here.`, e)
      }
      case 'post': {
        const L = this.lval(e.a)
        const old = this.readL(L)
        const nv = this.arith(e.op === '++' ? '+' : '-', old, { t: I, c: [1] }, e)
        this.writeL(L, this.conv(nv, L.t, e).c)
        return old
      }
      case 'assign': {
        const L = this.lval(e.a)
        let v = e.b.k === 'init' ? this.initList(e.b, L.t) : this.eval(e.b)
        if (e.op !== '=') { const op = e.op.slice(0, -1); v = ['&', '|', '^', '<<', '>>'].includes(op) ? this.bits(op, this.readL(L), v, e) : this.arith(op, this.readL(L), v, e) }
        v = this.conv(v, L.t, e, `the value given to ${this.describe(e.a)}`)
        this.writeL(L, v.c)
        return v
      }
      case 'bin': return this.binary(e)
      case 'field': return this.field(this.eval(e.a), e.name, e)
      case 'index': return this.index(this.eval(e.a), this.eval(e.i), e)
      case 'call': return this.call(e)
    }
  }
  describe(e: Expr): string { return e.k === 'id' ? `"${e.name}"` : e.k === 'field' ? `${this.describe(e.a)}.${e.name}` : 'it' }

  cond(v: Val, at: Expr): S {
    if (v.t.k !== 'num' || v.t.n !== 1) this.err(`a condition must be one true or false value, but this is a ${show(v.t)}.${v.t.k === 'num' ? ' Use any() or all() to check a whole vector.' : ''}`, at)
    const c = v.c[0]
    if (v.t.k === 'num' && v.t.b !== 'bool') return typeof c === 'number' ? (c !== 0 ? 1 : 0) : this.ne(c, 0)
    return c
  }
  common(a: Ty, b: Ty, at: Expr): Ty {
    if (eqTy(a, b)) return a
    if (a.k === 'num' && b.k === 'num') {
      const n = Math.max(a.n, b.n)
      if (a.n !== b.n && a.n !== 1 && b.n !== 1) this.err(`a ${show(a)} and a ${show(b)} cannot be used together here; they have a different number of parts.`, at)
      return vec(n, a.b === 'float' || b.b === 'float' ? 'float' : a.b === 'uint' || b.b === 'uint' ? 'uint' : a.b === 'int' || b.b === 'int' ? 'int' : 'bool')
    }
    return this.err(`a ${show(a)} and a ${show(b)} cannot be used together here.`, at)
  }

  binary(e: Extract<Expr, { k: 'bin' }>): Val {
    const op = e.op
    if (op === '&&' || op === '||') {
      const a = this.cond(this.eval(e.a), e.a)
      // short circuit when the left side is fixed, so guarded code such as (i < 3 && a[i] > 0.0) still works
      if (op === '&&' && a === 0) return { t: B, c: [0] }
      if (op === '||' && a === 1) return { t: B, c: [1] }
      const b = this.cond(this.eval(e.b), e.b)
      return { t: B, c: [op === '&&' ? this.and(a, b) : this.b.s('max', a, b)] }
    }
    const a = this.eval(e.a), b = this.eval(e.b)
    if (op === '^^') { const x = this.cond(a, e.a), y = this.cond(b, e.b); return { t: B, c: [this.b.s('abs', this.b.s('sub', x, y))] } }
    if (['<', '>', '<=', '>='].includes(op)) {
      if (a.t.k !== 'num' || b.t.k !== 'num' || a.t.n !== 1 || b.t.n !== 1) this.err(`"${op}" compares two single numbers. For vectors use lessThan() or greaterThan().`, e)
      const x = a.c[0], y = b.c[0]
      const r = op === '>' ? this.b.s('greater', x, y) : op === '<' ? this.b.s('greater', y, x) : op === '>=' ? this.not(this.b.s('greater', y, x)) : this.not(this.b.s('greater', x, y))
      return { t: B, c: [r] }
    }
    if (op === '==' || op === '!=') {
      const t = this.common(a.t, b.t, e)
      const A = this.conv(a, t, e).c, Bc = this.conv(b, t, e).c
      let all: S = 1
      for (let i = 0; i < A.length; i++) all = this.and(all, this.eq(A[i], Bc[i]))
      return { t: B, c: [op === '==' ? all : this.not(all)] }
    }
    if (['&', '|', '^', '<<', '>>'].includes(op)) return this.bits(op, a, b, e)
    return this.arith(op, a, b, e)
  }
  bits(op: string, a: Val, b: Val, e: Expr): Val {
    const t = this.common(a.t, b.t, e)
    const A = this.conv(a, t, e).c, Bc = this.conv(b, t, e).c
    const c = A.map((x, i) => {
      const y = Bc[i]
      if (typeof x === 'number' && typeof y === 'number') {
        const u = t.k === 'num' && t.b === 'uint'
        const r = op === '&' ? x & y : op === '|' ? x | y : op === '^' ? x ^ y : op === '<<' ? x << y : u ? x >>> y : x >> y
        return u ? r >>> 0 : r
      }
      // the few bit operations that are plain arithmetic on whole numbers that are not negative
      if (typeof y === 'number' && y >= 0 && y < 24 && Number.isInteger(y)) {
        if (op === '<<') return this.b.s('mul', x, 2 ** y)
        if (op === '>>') return this.b.s('floor', this.b.s('div', x, 2 ** y))
        if (op === '&' && Number.isInteger(Math.log2(y + 1))) return this.mod1(x, y + 1)
      }
      return this.err(HASH_HELP, e)
    })
    return { t, c }
  }
  mod1(x: S, y: S): S { return this.b.s('sub', x, this.b.s('mul', y, this.b.s('floor', this.b.s('div', x, y)))) }

  arith(op: string, a: Val, b: Val, e: Expr): Val {
    const IR: Record<string, string> = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div' }
    if (op === '*' && (a.t.k === 'mat' || b.t.k === 'mat') && !(a.t.k === 'num' && a.t.n === 1) && !(b.t.k === 'num' && b.t.n === 1)) return this.matmul(a, b, e)
    if (a.t.k === 'mat' || b.t.k === 'mat') {
      // matrix with matrix (same shape) or with a single number: part by part
      const t = a.t.k === 'mat' ? a.t : b.t
      if (a.t.k === 'mat' && b.t.k === 'mat' && !eqTy(a.t, b.t)) this.err(`a ${show(a.t)} and a ${show(b.t)} cannot be used together here.`, e)
      if (!IR[op]) this.err(`"${op}" does not work on matrices.`, e)
      return { t, c: this.b.ew(IR[op], a.c, b.c) }
    }
    if (a.t.k !== 'num' || b.t.k !== 'num') this.err(`"${op}" does not work on a ${show(a.t.k !== 'num' ? a.t : b.t)}.`, e)
    const t = this.common(a.t, b.t, e)
    const isInt = t.k === 'num' && t.b !== 'float'
    const A = this.conv(a, t, e).c, Bc = this.conv(b, t, e).c
    if (op === '%') {
      if (!isInt) this.err('"%" is for whole numbers (int). For decimal numbers use mod(a, b).', e)
      return { t, c: A.map((x, i) => (typeof x === 'number' && typeof Bc[i] === 'number' ? x % (Bc[i] as number) : this.mod1(x, Bc[i]))) }
    }
    if (!IR[op]) this.err(`"${op}" is not understood here.`, e)
    let c = this.b.ew(IR[op], A, Bc)
    if (isInt && op === '/') c = c.map((x) => this.trunc(x))
    if (t.k === 'num' && t.b === 'uint' && op === '*' && c.some((x) => typeof x !== 'number')) this.err(HASH_HELP, e)
    if (t.k === 'num' && t.b === 'uint') c = c.map((x) => (typeof x === 'number' ? x >>> 0 : x))
    else if (isInt) c = c.map((x) => (typeof x === 'number' ? x | 0 : x))
    return { t, c }
  }
  col(m: Val, j: number): S[] { const r = (m.t as { r: number }).r; return m.c.slice(j * r, j * r + r) }
  matmul(a: Val, b: Val, e: Expr): Val {
    const b_ = this.b
    const combo = (cols: S[][], w: S[]) => { let acc: S[] = Array(cols[0].length).fill(0); cols.forEach((c, j) => { acc = b_.ew('add', acc, b_.ew('mul', c, [w[j]])) }); return acc }
    if (a.t.k === 'mat' && b.t.k === 'num') {
      if (b.t.n !== a.t.c) this.err(`a ${show(a.t)} times a ${show(b.t)} does not fit: the vector needs ${a.t.c} parts.`, e)
      const cols = Array.from({ length: a.t.c }, (_, j) => this.col(a, j))
      return { t: vec(a.t.r), c: combo(cols, b.c) }
    }
    if (a.t.k === 'num' && b.t.k === 'mat') {
      if (a.t.n !== b.t.r) this.err(`a ${show(a.t)} times a ${show(b.t)} does not fit: the vector needs ${b.t.r} parts.`, e)
      return { t: vec(b.t.c), c: Array.from({ length: b.t.c }, (_, j) => this.dot(a.c, this.col(b, j))) }
    }
    if (a.t.k === 'mat' && b.t.k === 'mat') {
      if (a.t.c !== b.t.r) this.err(`a ${show(a.t)} times a ${show(b.t)} does not fit.`, e)
      const cols = Array.from({ length: a.t.c }, (_, j) => this.col(a, j))
      const out: S[] = []
      for (let j = 0; j < b.t.c; j++) out.push(...combo(cols, this.col(b, j)))
      return { t: { k: 'mat', c: b.t.c, r: a.t.r }, c: out }
    }
    return this.err('these cannot be multiplied.', e)
  }
  dot(a: S[], b: S[]): S {
    if (a.length === 1) return this.b.s('mul', a[0], b[0])
    if (a.every((x) => typeof x === 'number') && b.every((x) => typeof x === 'number')) return a.reduce((s: number, x, i) => s + (x as number) * (b[i] as number), 0)
    if (a.length <= 3) return this.dot3(a, b)
    return this.b.s('add', this.dot3(a.slice(0, 3), b.slice(0, 3)), this.b.s('mul', a[3], b[3]))
  }
  private dot3(a: S[], b: S[]): S {
    // a dot with fixed numbers is cheaper as plain sums when only one or two parts are not 0
    const id = this.b.vec('dot', a, b)
    return { f: id }
  }
  len(a: S[]): S {
    if (a.length === 1) return this.b.s('abs', a[0])
    if (a.length <= 3) return { f: this.b.vec('length', a) }
    return this.b.s('sqrt', this.dot(a, a))
  }

  field(v: Val, name: string, e: Expr): Val {
    if (v.t.k === 'struct') {
      let off = 0
      for (const f of v.t.fields) { if (f.name === name) return { t: f.t, c: v.c.slice(off, off + size(f.t)) }; off += size(f.t) }
      this.err(`${v.t.name} has no field "${name}".`, e)
    }
    if (v.t.k === 'num') {
      const idx = this.swizzle(name, v.t.n, e)
      return { t: vec(idx.length, v.t.b), c: idx.map((i) => v.c[i]) }
    }
    if (name === 'length') this.err('use .length() with brackets.', e)
    return this.err(`".${name}" does not work on a ${show(v.t)}.`, e)
  }
  swizzle(name: string, n: number, e: Expr): number[] {
    const set = SWZ.find((s) => s.includes(name[0]))
    if (!set || name.length > 4 || [...name].some((ch) => !set.includes(ch))) this.err(`".${name}" is not a part of a vector. Use letters from xyzw, rgba or stpq.`, e)
    const idx = [...name].map((ch) => set!.indexOf(ch))
    if (idx.some((i) => i >= n)) this.err(`".${name}" asks for a part this ${n === 1 ? 'number' : `vec${n}`} does not have.`, e)
    return idx
  }
  elem(t: Ty, e: Expr): { t: Ty; n: number; len: number } {
    if (t.k === 'arr') return { t: t.of, n: size(t.of), len: t.len }
    if (t.k === 'num' && t.n > 1) return { t: { k: 'num', b: t.b, n: 1 }, n: 1, len: t.n }
    if (t.k === 'mat') return { t: vec(t.r), n: t.r, len: t.c }
    return this.err(`[ ] does not work on a ${show(t)}.`, e)
  }
  index(v: Val, iv: Val, e: Expr): Val {
    const el = this.elem(v.t, e)
    const i = iv.c[0]
    const part = (k: number) => v.c.slice(k * el.n, k * el.n + el.n)
    if (typeof i === 'number') {
      if (i < 0 || i >= el.len) this.err(`position ${i} is outside this ${show(v.t)}, which has ${el.len} (0 to ${el.len - 1}).`, e)
      return { t: el.t, c: part(i) }
    }
    const r = this.b.range(i)
    let acc = part(Math.max(0, Math.min(el.len - 1, Math.ceil(r[0]))))
    for (let k = 0; k < el.len; k++) {
      if (k < r[0] - 0.5 || k > r[1] + 0.5) continue
      acc = this.sel(this.eqInt(i, k), part(k), acc)
    }
    return { t: el.t, c: acc }
  }

  // ---------------------------------------------------------------- assignable places
  lval(e: Expr): LVal {
    switch (e.k) {
      case 'id': {
        const v = this.lookup(e.name) ?? this.output(e.name, e)
        if (!v) {
          if (this.builtin(e.name, e)) this.err(`"${e.name}" is an input and cannot be changed. Copy it first: float my${e.name} = ${e.name};`, e)
          this.err(notDefined(e.name), e)
        }
        if (v!.isConst) this.err(`"${e.name}" is const, so it cannot be changed.`, e)
        return { v: v!, t: v!.t, alts: [{ c: 1, idx: v!.c.map((_, i) => i) }] }
      }
      case 'field': {
        const L = this.lval(e.a)
        if (L.t.k === 'struct') {
          let off = 0
          for (const f of L.t.fields) { if (f.name === e.name) return { v: L.v, t: f.t, alts: L.alts.map((a) => ({ c: a.c, idx: a.idx.slice(off, off + size(f.t)) })) }; off += size(f.t) }
          this.err(`${L.t.name} has no field "${e.name}".`, e)
        }
        if (L.t.k === 'num') {
          const sw = this.swizzle(e.name, L.t.n, e)
          if (new Set(sw).size !== sw.length) this.err(`".${e.name}" uses a part twice, so it cannot be written to.`, e)
          return { v: L.v, t: vec(sw.length, L.t.b), alts: L.alts.map((a) => ({ c: a.c, idx: sw.map((i) => a.idx[i]) })) }
        }
        return this.err(`".${e.name}" does not work on a ${show(L.t)}.`, e)
      }
      case 'index': {
        const L = this.lval(e.a)
        const el = this.elem(L.t, e)
        const i = this.eval(e.i).c[0]
        if (typeof i === 'number') {
          if (i < 0 || i >= el.len) this.err(`position ${i} is outside this ${show(L.t)}, which has ${el.len} (0 to ${el.len - 1}).`, e)
          return { v: L.v, t: el.t, alts: L.alts.map((a) => ({ c: a.c, idx: a.idx.slice(i * el.n, i * el.n + el.n) })) }
        }
        const r = this.b.range(i)
        const alts: LVal['alts'] = []
        for (const a of L.alts) for (let k = 0; k < el.len; k++) {
          if (k < r[0] - 0.5 || k > r[1] + 0.5) continue
          alts.push({ c: this.and(a.c, this.eqInt(i, k)), idx: a.idx.slice(k * el.n, k * el.n + el.n) })
        }
        return { v: L.v, t: el.t, alts }
      }
    }
    return this.err('only a variable (or a part of one) can be given a value here.', e)
  }
  readL(L: LVal): Val {
    const c = this.read(L.v)
    let acc = L.alts[0].idx.map((j) => c[j])
    for (let k = 1; k < L.alts.length; k++) acc = this.sel(L.alts[k].c, L.alts[k].idx.map((j) => c[j]), acc)
    return { t: L.t, c: acc }
  }
  writeL(L: LVal, c: S[]) { for (const a of L.alts) this.write(L.v, a.idx, c, a.c) }

  initList(e: Extract<Expr, { k: 'init' }>, t: Ty): Val {
    if (t.k === 'arr') {
      const len = t.len === -1 ? e.list.length : t.len
      if (e.list.length !== len) this.err(`this list has ${e.list.length} values, but the array holds ${len}.`, e)
      const c: S[] = []
      for (const x of e.list) c.push(...(x.k === 'init' ? this.initList(x, t.of) : this.conv(this.eval(x), t.of, x)).c)
      return { t: { k: 'arr', of: t.of, len }, c }
    }
    if (t.k === 'struct') {
      const c: S[] = []
      t.fields.forEach((f, i) => { const x = e.list[i]; if (!x) this.err(`this list is missing a value for "${f.name}".`, e); c.push(...(x.k === 'init' ? this.initList(x, f.t) : this.conv(this.eval(x), f.t, x)).c) })
      return { t, c }
    }
    const parts = e.list.map((x) => this.eval(x))
    return this.ctor(t, parts, e)
  }

  // ---------------------------------------------------------------- constructors
  ctor(t: Ty, a: Val[], at: { line: number; col?: number }): Val {
    if (t.k === 'num') {
      const flat: S[] = []
      for (const v of a) {
        if (v.t.k === 'num') flat.push(...this.toBase(v.c, v.t.b, t.b))
        else if (v.t.k === 'mat') flat.push(...v.c)
        else this.err(`a ${show(v.t)} cannot be turned into a ${show(t)}.`, at)
      }
      if (a.length === 1 && a[0].t.k === 'num' && a[0].t.n === 1) return { t, c: Array(t.n).fill(flat[0]) }
      if (flat.length < t.n) this.err(`${show(t)}() needs ${t.n} values here, but only ${flat.length} ${flat.length === 1 ? 'is' : 'are'} given.`, at)
      return { t, c: flat.slice(0, t.n) }
    }
    if (t.k === 'mat') {
      if (a.length === 1 && a[0].t.k === 'num' && a[0].t.n === 1) {
        const c: S[] = []
        for (let j = 0; j < t.c; j++) for (let i = 0; i < t.r; i++) c.push(i === j ? a[0].c[0] : 0)
        return { t, c }
      }
      if (a.length === 1 && a[0].t.k === 'mat') {
        const m = a[0], mt = m.t as { c: number; r: number }
        const c: S[] = []
        for (let j = 0; j < t.c; j++) for (let i = 0; i < t.r; i++) c.push(j < mt.c && i < mt.r ? m.c[j * mt.r + i] : i === j ? 1 : 0)
        return { t, c }
      }
      const flat = a.flatMap((v) => v.c)
      if (flat.length !== t.c * t.r) this.err(`${show(t)}() needs ${t.c * t.r} values, but ${flat.length} are given.`, at)
      return { t, c: flat }
    }
    if (t.k === 'struct') {
      if (a.length !== t.fields.length) this.err(`${t.name}() needs ${t.fields.length} values, one for each field.`, at)
      return { t, c: t.fields.flatMap((f, i) => this.conv(a[i], f.t, at, `the value for "${f.name}"`).c) }
    }
    if (t.k === 'arr') {
      const len = t.len === -1 ? a.length : t.len
      if (a.length !== len) this.err(`this array holds ${len} values, but ${a.length} are given.`, at)
      return { t: { k: 'arr', of: t.of, len }, c: a.flatMap((v) => this.conv(v, t.of, at).c) }
    }
    return this.err(`a ${show(t)} cannot be made this way.`, at)
  }

  // ---------------------------------------------------------------- calls
  call(e: Extract<Expr, { k: 'call' }>): Val {
    if (e.fn === '.length') {
      const v = this.eval(e.args[0])
      if (v.t.k === 'arr') return { t: I, c: [v.t.len] }
      if (v.t.k === 'num') return { t: I, c: [v.t.n] }
      if (v.t.k === 'mat') return { t: I, c: [v.t.c] }
      return this.err('.length() works on arrays and vectors.', e)
    }
    if (e.arr) {
      let t = basic(e.fn) ?? this.structs.get(e.fn)!
      for (let i = e.arr.length - 1; i >= 0; i--) t = this.arrOf(t, e.arr[i], e)
      return this.ctor(t, e.args.map((x) => this.eval(x)), e)
    }
    const userFns = this.fns.get(e.fn)
    if (userFns) return this.callUser(e, userFns)
    const t = basic(e.fn) ?? this.structs.get(e.fn)
    if (t) {
      if (t.k === 'sampler' || t.k === 'void') this.err(`${e.fn}() cannot be made here.`, e)
      return this.ctor(t, e.args.map((x) => this.eval(x)), e)
    }
    const a = e.args.map((x) => this.eval(x))
    const r = this.lib(e.fn, a, e) ?? this.extra(e.fn, a, e)
    if (r) return r
    return this.err(`"${e.fn}" is not a function GLSL or this shader has. Check the spelling, or add the function above this line.`, e)
  }
  pick(fns: Fn[], a: Val[], e: Extract<Expr, { k: 'call' }>): Fn {
    let best: Fn | undefined, bestScore = -1
    for (const f of fns) {
      if (f.params.length !== a.length) continue
      let score = 0
      for (let i = 0; i < a.length && score >= 0; i++) {
        const pt = this.type(f.params[i].type, f)
        if (eqTy(pt, a[i].t) || (pt.k === 'arr' && a[i].t.k === 'arr' && pt.len === -1)) score += 3
        else if (pt.k === 'num' && a[i].t.k === 'num' && pt.n === a[i].t.n) score += 2
        else if (pt.k === 'num' && a[i].t.k === 'num' && a[i].t.n === 1) score += 0
        else score = -1
      }
      if (score > bestScore) { best = f; bestScore = score }
    }
    if (!best) {
      const counts = [...new Set(fns.map((f) => f.params.length))].join(' or ')
      const shapes = a.map((v) => show(v.t)).join(', ')
      this.err(fns.some((f) => f.params.length === a.length) ? `${e.fn}() does not take (${shapes}). It takes (${fns.map((f) => f.params.map((p) => p.type.name).join(', ')).join(') or (')}).` : `${e.fn}() takes ${counts} value${counts === '1' ? '' : 's'}, but ${a.length} ${a.length === 1 ? 'is' : 'are'} given.`, e)
    }
    return best!
  }
  callUser(e: Extract<Expr, { k: 'call' }>, fns: Fn[]): Val {
    const a = e.args.map((x) => this.eval(x))
    const f = this.pick(fns, a, e)
    const outs: (LVal | null)[] = f.params.map((p, i) => (p.q === 'in' ? null : this.lval(e.args[i])))
    return this.inline(f, a, outs, e)
  }
  inline(f: Fn, a: Val[], outs: (LVal | null)[], at: { line: number; col?: number }): Val {
    if (this.calling.includes(f.name)) this.err(`${f.name}() calls itself. Nodes cannot repeat a function inside itself; rewrite it with a loop instead.`, at)
    if (this.calling.length > 64) this.err('functions call each other too deeply here.', at)
    const saveScopes = this.scopes, saveLoops = this.loops, m0 = this.mask, k0 = this.kills, d0 = this.discard, line = this.b.line
    const retTy = this.type(f.ret, f)
    this.scopes = [this.globals, new Map()]
    this.loops = []
    const params = f.params.map((p, i) => {
      const t = this.type(p.type, f)
      const v = p.q === 'out' ? { t: t.k === 'arr' && t.len === -1 ? a[i].t : t, c: this.zero(t.k === 'arr' && t.len === -1 ? a[i].t : t) } : this.conv(a[i], t, at, `value ${i + 1} of ${f.name}()`)
      return this.declare(p.name || `_${i}`, v.t, v.c.slice(), p.isConst)
    })
    const ret: Var = { t: retTy, c: this.zero(retTy), base: key(this.mask), name: 'return' }
    this.frames.push({ ret, retTy, name: f.name })
    this.calling.push(f.name)
    try {
      for (const s of f.body) this.exec(s)
    } catch (err) {
      // a random-number function built from integer bit tricks: it becomes white noise of its inputs, which
      // keeps the look (a different random pattern) and is the same in every program
      if (!(err instanceof CodeError) || !err.message.includes(HASH_HELP) || retTy.k !== 'num' || outs.some(Boolean)) throw err
      this.calling.length = this.calling.lastIndexOf(f.name)
      this.frames.pop()
      this.scopes = saveScopes; this.loops = saveLoops; this.mask = m0; this.kills = k0; this.discard = d0; this.b.line = line
      if (!this.hashed.has(f.name)) {
        this.hashed.add(f.name)
        this.warn(f.line, `${f.name}() makes random numbers with integer bit tricks, which nodes cannot do. It has been swapped for white noise of the same inputs: the look is the same, the random pattern is different.`)
      }
      return { t: retTy, c: this.randomLike(a, retTy) }
    }
    this.calling.pop()
    this.frames.pop()
    this.scopes = saveScopes; this.loops = saveLoops
    if (this.discard !== d0) this.mask = this.and(m0, this.not(this.discard))
    else { this.mask = m0; this.kills = k0 }
    this.b.line = line
    outs.forEach((L, i) => { if (L) this.writeL(L, this.conv({ t: params[i].t, c: params[i].c }, L.t, at).c) })
    return { t: retTy, c: ret.c }
  }

  hashed = new Set<string>()
  /** a random value 0..1 for each part of t, spread over the integer range for int and uint results */
  randomLike(a: Val[], t: Ty): S[] {
    const parts = a.flatMap((v) => v.c)
    const p: S[] = [0, 0, 0]
    parts.forEach((x, j) => {
      const k = j % 3, w = 1 + 0.6180339887 * Math.floor(j / 3)
      p[k] = this.b.s('add', p[k], w === 1 ? x : this.b.s('mul', x, w))
    })
    const out: S[] = []
    for (let i = 0; i < size(t); i++) {
      const q = i === 0 ? p : p.map((x, k) => this.b.s('add', x, 17.31 * (i + 1) + 3.7 * k))
      const id = this.b.node('white_noise', { p: this.b.v3(q) }, 'float')
      this.b.ranges.set(id, [0, 1])
      const r: S = { f: id }
      out.push(t.b === 'uint' ? this.b.s('floor', this.b.s('mul', r, 4294967295)) : t.b === 'int' ? this.b.s('floor', this.b.s('mul', r, 2147483647)) : t.b === 'bool' ? this.b.s('greater', r, 0.5) : r)
    }
    return out
  }

  // ---------------------------------------------------------------- statements
  exec(s: Stmt) {
    if (this.mask === 0) return
    if (++this.work > MAX_WORK) this.err('this shader runs too many steps to turn into nodes. Lower the loop counts and try again.', s)
    this.b.line = s.line
    switch (s.k) {
      case 'empty': return
      case 'expr': this.eval(s.e); return
      case 'decl': {
        if (s.quals.includes('uniform') || s.quals.includes('in') || s.quals.includes('out')) this.err('uniform, in and out go at the top of the shader, outside any function.', s)
        for (const d of s.vars) {
          this.b.line = d.line
          let t = this.type({ ...s.type, arr: [...s.type.arr, ...d.arr] }, d)
          let v: Val
          if (d.init) {
            v = d.init.k === 'init' ? this.initList(d.init, t) : this.eval(d.init)
            if (t.k === 'arr' && t.len === -1 && v.t.k === 'arr') t = v.t
            v = this.conv(v, t, d, `the value given to "${d.name}"`)
          } else {
            if (t.k === 'arr' && t.len === -1) this.err(`the array "${d.name}" needs a size, such as ${d.name}[4].`, d)
            v = { t, c: this.zero(t) }
          }
          this.declare(d.name, t, v.c.slice(), s.quals.includes('const'))
        }
        return
      }
      case 'block': {
        this.scopes.push(new Map())
        for (const x of s.list) this.exec(x)
        this.scopes.pop()
        return
      }
      case 'if': {
        const c = this.cond(this.eval(s.c), s.c)
        if (c === 1) { this.sub(s.a); return }
        if (c === 0) { if (s.b) this.sub(s.b); return }
        const m0 = this.mask, k0 = this.kills
        this.mask = this.and(m0, c)
        this.sub(s.a)
        const mA = this.mask
        this.mask = this.and(m0, this.not(c))
        if (s.b) this.sub(s.b)
        const mB = this.mask
        this.mask = this.kills === k0 ? m0 : this.or(mA, mB)
        return
      }
      case 'for': case 'while': case 'do': return this.loop(s)
      case 'switch': return this.switch(s)
      case 'break': case 'continue': {
        let f: Loop | undefined
        for (let i = this.loops.length - 1; i >= 0; i--) if (s.k === 'break' || !this.loops[i].sw) { f = this.loops[i]; break }
        if (!f) this.err(`"${s.k}" is only allowed inside a loop${s.k === 'break' ? ' or switch' : ''}.`, s)
        if (s.k === 'break') f!.out = this.or(f!.out, this.mask); else f!.cont = this.or(f!.cont, this.mask)
        this.mask = 0; this.kills++
        return
      }
      case 'return': {
        const fr = this.frames[this.frames.length - 1]
        if (s.e) {
          if (fr.retTy.k === 'void') this.err(`${fr.name}() is void, so it cannot return a value.`, s)
          const v = this.conv(this.eval(s.e), fr.retTy, s, `the value ${fr.name}() returns`)
          this.write(fr.ret, v.c.map((_, i) => i), v.c)
        }
        this.mask = 0; this.kills++
        return
      }
      case 'discard':
        this.discard = this.or(this.discard, this.mask)
        this.mask = 0; this.kills++
        return
    }
  }
  sub(s: Stmt) { this.scopes.push(new Map()); this.exec(s); this.scopes.pop() }

  loop(s: Extract<Stmt, { k: 'for' | 'while' | 'do' }>) {
    this.scopes.push(new Map())
    if (s.k === 'for' && s.init) this.exec(s.init)
    const f: Loop = { out: 0, cont: 0, sw: false }
    this.loops.push(f)
    let steps = 0, symbolic = 0
    const check = () => {
      const c = s.c ? this.cond(this.eval(s.c), s.c) : 1
      if (typeof c !== 'number') symbolic++
      if (c === 1) return true
      if (c === 0) { f.out = this.or(f.out, this.mask); this.mask = 0; return false }
      f.out = this.or(f.out, this.and(this.mask, this.not(c)))
      this.mask = this.and(this.mask, c)
      return true
    }
    let first = s.k === 'do'
    while (this.mask !== 0) {
      if (!first && !check()) break
      first = false
      if (this.mask === 0) break
      if (s.k !== 'for' && !s.c) symbolic++
      if (++steps > MAX_STEPS) this.err(`this loop runs more than ${MAX_STEPS} times, which is too many to turn into nodes. Lower its count.`, s)
      if (symbolic > MAX_SYMBOLIC_STEPS) {
        // no end that can be worked out ahead: it stops here, which is plenty for nearly every such loop
        this.warn(s.line, `This loop has no fixed end, so it stops after ${MAX_SYMBOLIC_STEPS} rounds here. If it needs more, the picture can differ where it would have kept going. To choose the most rounds yourself, write it like this: for (int i = 0; i < 200; i++) { ... if (done) break; }. If the count comes from a uniform, add // @range 1 64 after that uniform.`)
        f.out = this.or(f.out, this.mask); this.mask = 0
        break
      }
      this.scopes.push(new Map())
      this.exec(s.body)
      this.scopes.pop()
      this.mask = this.or(this.mask, f.cont)
      f.cont = 0
      if (this.mask === 0) break
      if (s.k === 'for' && s.step) { this.b.line = s.line; this.eval(s.step) }
    }
    this.loops.pop()
    this.mask = f.out
    this.scopes.pop()
  }

  switch(s: Extract<Stmt, { k: 'switch' }>) {
    const v = this.eval(s.e).c[0]
    const f: Loop = { out: 0, cont: 0, sw: true }
    this.loops.push(f)
    const m0 = this.mask
    const conds = s.cases.map((c) => (c.v ? this.eqInt(v, this.eval(c.v).c[0]) : null))
    let any: S = 0
    for (const c of conds) if (c !== null) any = this.b.s('max', any, c)
    let falling: S = 0
    s.cases.forEach((c, i) => {
      const enter = this.and(m0, conds[i] ?? this.not(any))
      this.mask = this.or(falling, enter)
      this.scopes.push(new Map())
      for (const x of c.body) this.exec(x)
      this.scopes.pop()
      falling = this.mask
    })
    this.loops.pop()
    this.mask = this.or(f.out, falling)
    // nothing matched and there is no default: those parts carry on too
    if (!s.cases.some((c) => !c.v)) this.mask = this.or(this.mask, this.and(m0, this.not(any)))
  }

  // ---------------------------------------------------------------- the GLSL library, built from Inoscula ops
  lib(fn: string, a: Val[], e: Expr): Val | undefined {
    const b = this.b
    const need = (n: number, m = n) => { if (a.length < n || a.length > m) this.err(`${fn}() takes ${n === m ? n : `${n} or ${m}`} value${m === 1 ? '' : 's'}, but ${a.length} ${a.length === 1 ? 'is' : 'are'} given.`, e) }
    const gen = () => { const t = a.find((v) => v.t.k === 'num' && v.t.n > 1)?.t ?? a.find((v) => v.t.k === 'mat')?.t ?? (a[0]?.t.k === 'num' && a[0].t.b !== 'float' && a.every((v) => v.t.k === 'num' && v.t.b !== 'float') ? a[0].t : F); return t.k === 'num' ? vec(t.n, a.every((v) => v.t.k === 'num' && v.t.b === (t as { b: Base }).b) ? t.b : 'float') : t }
    const fl = (v: Val) => { if (v.t.k !== 'num' && v.t.k !== 'mat') this.err(`${fn}() takes numbers or vectors, not a ${show(v.t)}.`, e); return v.c }
    const shape = (t: Ty) => { for (const v of a) if (v.t.k === 'num' && v.t.n > 1 && size(v.t) !== size(t)) this.err(`${fn}() is given a ${show(v.t)} and a ${show(t)}; they need the same number of parts.`, e) }
    const one = (f: (x: S[]) => S[]) => { need(1); const t = gen(); return { t, c: f(fl(a[0])) } }
    const ew = (op: string, ...x: S[][]) => b.ew(op, ...x)
    const mul = (x: S[], y: S[]) => ew('mul', x, y), add = (x: S[], y: S[]) => ew('add', x, y), sub = (x: S[], y: S[]) => ew('sub', x, y), div = (x: S[], y: S[]) => ew('div', x, y)
    const sq = (x: S[]) => mul(x, x)
    const sign = (x: S[]) => sub(ew('greater', x, [0]), ew('greater', [0], x))
    const log = (x: S[]) => ew('log', x)
    switch (fn) {
      case 'sin': case 'cos': case 'abs': case 'floor': case 'fract': case 'exp': case 'sqrt': return one((x) => ew(fn, x))
      case 'tan': return one((x) => div(ew('sin', x), ew('cos', x)))
      case 'asin': return one((x) => ew('atan2', x, ew('sqrt', sub([1], sq(x)))))
      case 'acos': return one((x) => ew('atan2', ew('sqrt', sub([1], sq(x))), x))
      case 'atan': {
        need(1, 2); const t = gen()
        if (a.length === 1) return { t, c: ew('atan2', fl(a[0]), [1]) }
        shape(t)
        return { t, c: ew('atan2', fl(a[0]), fl(a[1])) }
      }
      case 'sinh': return one((x) => mul(sub(ew('exp', x), ew('exp', mul(x, [-1]))), [0.5]))
      case 'cosh': return one((x) => mul(add(ew('exp', x), ew('exp', mul(x, [-1]))), [0.5]))
      case 'tanh': return one((x) => sub([1], div([2], add(ew('exp', mul(x, [2])), [1]))))
      case 'asinh': return one((x) => mul(sign(x), log(add(ew('abs', x), ew('sqrt', add(sq(x), [1]))))))
      case 'acosh': return one((x) => log(add(x, ew('sqrt', sub(sq(x), [1])))))
      case 'atanh': return one((x) => mul(log(div(add([1], x), sub([1], x))), [0.5]))
      case 'radians': return one((x) => mul(x, [Math.PI / 180]))
      case 'degrees': return one((x) => mul(x, [180 / Math.PI]))
      case 'exp2': return one((x) => ew('pow', [2], x))
      case 'log': return one((x) => log(x))
      case 'log2': return one((x) => mul(log(x), [1 / Math.LN2]))
      case 'inversesqrt': return one((x) => div([1], ew('sqrt', x)))
      case 'sign': return one((x) => sign(x))
      case 'ceil': return one((x) => mul(ew('floor', mul(x, [-1])), [-1]))
      case 'round': case 'roundEven': return one((x) => ew('floor', add(x, [0.5])))
      case 'trunc': return one((x) => x.map((s) => this.trunc(s)))
      case 'pow': { need(2); const t = gen(); shape(t); return { t, c: ew('pow', fl(a[0]), fl(a[1])) } }
      case 'mod': { need(2); const t = gen(); shape(t); const x = fl(a[0]), y = fl(a[1]); return { t, c: sub(x, mul(y, ew('floor', div(x, y)))) } }
      case 'min': case 'max': { need(2); const t = gen(); shape(t); return { t, c: ew(fn, fl(a[0]), fl(a[1])) } }
      case 'clamp': { need(3); const t = gen(); shape(t); return { t, c: ew('clamp', fl(a[0]), fl(a[1]), fl(a[2])) } }
      case 'saturate': return one((x) => ew('clamp', x, [0], [1]))
      case 'step': { need(2); const t = gen(); shape(t); return { t, c: ew('one_minus', ew('greater', fl(a[0]), fl(a[1]))) } }
      case 'smoothstep': { need(3); const t = gen(); shape(t); return { t, c: ew('smoothstep', fl(a[0]), fl(a[1]), fl(a[2])) } }
      case 'fma': { need(3); const t = gen(); shape(t); return { t, c: add(mul(fl(a[0]), fl(a[1])), fl(a[2])) } }
      case 'mix': case 'lerp': {
        need(3)
        const t = gen(); shape(t)
        const x = fl(a[0]), y = fl(a[1]), w = fl(a[2])
        if (a[2].t.k === 'num' && a[2].t.b === 'bool') { const n = size(t); const X = x.length === 1 ? Array(n).fill(x[0]) : x, Y = y.length === 1 ? Array(n).fill(y[0]) : y; return { t, c: X.map((xi, i) => this.sel(w.length === 1 ? w[0] : w[i], [Y[i]], [xi])[0]) } }
        if (w.length === 1 && b.unit(w[0])) return { t, c: ew('mix', x, y, w) }
        return { t, c: add(x, mul(sub(y, x), w)) }
      }
      case 'length': { need(1); return { t: F, c: [this.len(fl(a[0]))] } }
      case 'distance': { need(2); shape(a[0].t); return { t: F, c: [this.len(sub(fl(a[0]), fl(a[1])))] } }
      case 'dot': { need(2); shape(a[0].t); return { t: F, c: [this.dot(fl(a[0]), fl(a[1]))] } }
      case 'normalize': {
        need(1); const x = fl(a[0])
        if (x.length === 1) return { t: F, c: sign(x) }
        if (x.length <= 3) return { t: a[0].t, c: b.parts(b.vec('normalize', x), x.length) }
        return { t: a[0].t, c: div(x, [this.len(x)]) }
      }
      case 'cross': {
        need(2)
        if (size(a[0].t) !== 3 || size(a[1].t) !== 3) this.err('cross() takes two vec3 values.', e)
        const [x, y] = [a[0].c, a[1].c]
        const p = (v: S[], o: number[]) => o.map((i) => v[i])
        return { t: vec(3), c: sub(mul(p(x, [1, 2, 0]), p(y, [2, 0, 1])), mul(p(x, [2, 0, 1]), p(y, [1, 2, 0]))) }
      }
      case 'reflect': { need(2); const i = fl(a[0]), n = fl(a[1]); return { t: a[0].t, c: sub(i, mul(n, [b.s('mul', 2, this.dot(n, i))])) } }
      case 'refract': {
        need(3)
        const i = fl(a[0]), n = fl(a[1]), eta = a[2].c[0]
        const d = this.dot(n, i)
        const k = b.s('sub', 1, b.s('mul', b.s('mul', eta, eta), b.s('sub', 1, b.s('mul', d, d))))
        const r = sub(mul(i, [eta]), mul(n, [b.s('add', b.s('mul', eta, d), b.s('sqrt', k))]))
        return { t: a[0].t, c: this.sel(b.s('greater', 0, k), this.zero(a[0].t), r) }
      }
      case 'faceforward': { need(3); const n = fl(a[0]); const d = this.dot(fl(a[2]), fl(a[1])); return { t: a[0].t, c: this.sel(b.s('greater', 0, d), n, mul(n, [-1])) } }
      case 'matrixCompMult': need(2); return { t: a[0].t, c: mul(a[0].c, a[1].c) }
      case 'outerProduct': {
        need(2)
        const c = a[0].c, r = a[1].c
        return { t: { k: 'mat', c: r.length, r: c.length }, c: r.flatMap((rj) => mul(c, [rj])) }
      }
      case 'transpose': {
        need(1); const m = a[0]; if (m.t.k !== 'mat') this.err('transpose() takes a matrix.', e)
        const { c: C, r: R } = m.t as { c: number; r: number }
        const out: S[] = []
        for (let j = 0; j < R; j++) for (let i = 0; i < C; i++) out.push(m.c[i * R + j])
        return { t: { k: 'mat', c: R, r: C }, c: out }
      }
      case 'determinant': { need(1); const m = this.square(a[0], e); return { t: F, c: [this.det(m)] } }
      case 'inverse': {
        need(1); const m = this.square(a[0], e); const n = m.length
        const d = this.det(m)
        const out: S[] = []
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
          // inverse[j][i] (column j, row i) = cofactor of m[i][j] / det
          const minor = m.filter((_, ci) => ci !== i).map((col) => col.filter((_, ri) => ri !== j))
          const cof = b.s('mul', (i + j) % 2 ? -1 : 1, this.det(minor))
          out.push(b.s('div', cof, d))
        }
        return { t: a[0].t, c: out }
      }
      case 'lessThan': case 'lessThanEqual': case 'greaterThan': case 'greaterThanEqual': case 'equal': case 'notEqual': {
        need(2)
        const x = fl(a[0]), y = fl(a[1])
        const c = x.map((xi, i) => {
          const yi = y[i]
          switch (fn) {
            case 'lessThan': return b.s('greater', yi, xi)
            case 'lessThanEqual': return this.not(b.s('greater', xi, yi))
            case 'greaterThan': return b.s('greater', xi, yi)
            case 'greaterThanEqual': return this.not(b.s('greater', yi, xi))
            case 'equal': return this.eq(xi, yi)
            default: return this.ne(xi, yi)
          }
        })
        return { t: vec(x.length, 'bool'), c }
      }
      case 'any': need(1); return { t: B, c: [a[0].c.reduce((s: S, x) => b.s('max', s, x), 0)] }
      case 'all': need(1); return { t: B, c: [a[0].c.reduce((s: S, x) => this.and(s, x), 1)] }
      case 'not': need(1); return { t: a[0].t, c: a[0].c.map((x) => this.not(x)) }
      case 'isnan': case 'isinf': need(1); return { t: vec(size(a[0].t), 'bool'), c: this.zero(a[0].t) }
      case 'dFdx': case 'dFdy': case 'fwidth': case 'dFdxFine': case 'dFdyFine': case 'dFdxCoarse': case 'dFdyCoarse': case 'fwidthFine': case 'fwidthCoarse':
        need(1)
        this.warn(e.line, `${fn}() measures how fast a value changes between pixels. Nodes cannot do that, so it is 0 here, and edges that used it for smoothing are sharp. For smooth edges, use a small fixed width instead, for example smoothstep(0.0, 0.01, d).`)
        return { t: a[0].t, c: this.zero(a[0].t) }
      case 'texture': case 'texture2D': case 'textureLod': case 'texelFetch': case 'textureGrad': case 'texture2DLod': case 'textureCube': case 'textureSize': case 'textureProj': case 'texture3D': case 'textureOffset': case 'texelFetchOffset': case 'textureLodOffset':
      case 'tex2D': case 'tex2Dlod': case 'tex2Dbias': case 'tex2Dgrad': case 'tex2Dproj': case 'tex3D': case 'texCUBE': case 'texCUBElod':
        return this.err(`${fn}() reads a picture. A material made of nodes cannot read pictures from a shader yet, so remove the lines that use it, or put a pattern such as noise(p) in their place.`, e)
      case 'floatBitsToInt': case 'floatBitsToUint': case 'intBitsToFloat': case 'uintBitsToFloat': case 'packHalf2x16': case 'unpackHalf2x16': case 'packUnorm2x16': case 'unpackUnorm2x16': case 'packSnorm2x16': case 'unpackSnorm2x16': case 'bitfieldExtract': case 'bitfieldInsert': case 'bitfieldReverse': case 'bitCount': case 'findLSB': case 'findMSB': case 'packUnorm4x8': case 'unpackUnorm4x8':
        return this.err(HASH_HELP, e)
    }
    return undefined
  }
  square(m: Val, e: Expr): S[][] {
    if (m.t.k !== 'mat' || m.t.c !== m.t.r) this.err('this takes a square matrix (mat2, mat3 or mat4).', e)
    const n = (m.t as { c: number }).c
    return Array.from({ length: n }, (_, j) => m.c.slice(j * n, j * n + n))
  }
  det(m: S[][]): S {
    const b = this.b
    if (m.length === 1) return m[0][0]
    if (m.length === 2) return b.s('sub', b.s('mul', m[0][0], m[1][1]), b.s('mul', m[1][0], m[0][1]))
    let d: S = 0
    for (let j = 0; j < m.length; j++) {
      const minor = m.filter((_, cj) => cj !== j).map((col) => col.slice(1))
      d = b.s(j % 2 ? 'sub' : 'add', d, b.s('mul', m[j][0], this.det(minor)))
    }
    return d
  }
}
