// GLSL tokens to a tree: declarations, functions, statements and expressions (GLSL ES 3.0 and the older 1.0).
import { CodeError } from '../lang.ts'
import type { Tok } from './pre.ts'

export type TypeName = { name: string; arr: (Expr | null)[]; line: number }
export type Expr =
  | { k: 'num'; v: string; line: number; col: number }
  | { k: 'id'; name: string; line: number; col: number }
  | { k: 'bin'; op: string; a: Expr; b: Expr; line: number; col: number }
  | { k: 'un'; op: string; a: Expr; line: number; col: number }
  | { k: 'post'; op: string; a: Expr; line: number; col: number }
  | { k: 'assign'; op: string; a: Expr; b: Expr; line: number; col: number }
  | { k: 'cond'; c: Expr; a: Expr; b: Expr; line: number; col: number }
  | { k: 'call'; fn: string; arr?: (Expr | null)[]; args: Expr[]; line: number; col: number }
  | { k: 'field'; a: Expr; name: string; line: number; col: number }
  | { k: 'index'; a: Expr; i: Expr; line: number; col: number }
  | { k: 'seq'; list: Expr[]; line: number; col: number }
  | { k: 'init'; list: Expr[]; line: number; col: number }
export type VarDecl = { name: string; arr: (Expr | null)[]; init?: Expr; line: number; col: number }
export type Stmt =
  | { k: 'decl'; type: TypeName; quals: string[]; vars: VarDecl[]; line: number }
  | { k: 'expr'; e: Expr; line: number }
  | { k: 'if'; c: Expr; a: Stmt; b?: Stmt; line: number }
  | { k: 'for'; init?: Stmt; c?: Expr; step?: Expr; body: Stmt; line: number }
  | { k: 'while'; c: Expr; body: Stmt; line: number }
  | { k: 'do'; c: Expr; body: Stmt; line: number }
  | { k: 'switch'; e: Expr; cases: { v: Expr | null; body: Stmt[]; line: number }[]; line: number }
  | { k: 'break' | 'continue' | 'discard' | 'empty'; line: number }
  | { k: 'return'; e?: Expr; line: number }
  | { k: 'block'; list: Stmt[]; line: number }
export type FnParam = { q: 'in' | 'out' | 'inout'; type: TypeName; name: string; isConst: boolean }
export type Fn = { ret: TypeName; name: string; params: FnParam[]; body: Stmt[]; line: number }
export type StructDef = { name: string; fields: { type: TypeName; name: string }[]; line: number }
export type Global = { k: 'decl'; d: Extract<Stmt, { k: 'decl' }> } | { k: 'fn'; f: Fn } | { k: 'struct'; s: StructDef } | { k: 'block'; name: string; d: Extract<Stmt, { k: 'decl' }>[]; line: number }
export type Program = { globals: Global[] }

const BASIC = new Set(['void', 'float', 'int', 'uint', 'bool', 'double',
  'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4', 'uvec2', 'uvec3', 'uvec4', 'bvec2', 'bvec3', 'bvec4', 'dvec2', 'dvec3', 'dvec4',
  'mat2', 'mat3', 'mat4', 'mat2x2', 'mat2x3', 'mat2x4', 'mat3x2', 'mat3x3', 'mat3x4', 'mat4x2', 'mat4x3', 'mat4x4',
  'sampler2D', 'sampler3D', 'samplerCube', 'sampler2DArray', 'isampler2D', 'usampler2D', 'sampler2DShadow', 'samplerCubeShadow', 'sampler2DRect', 'samplerExternalOES'])
const QUALS = new Set(['const', 'uniform', 'in', 'out', 'inout', 'varying', 'attribute', 'highp', 'mediump', 'lowp', 'flat', 'smooth', 'noperspective', 'centroid', 'invariant', 'precise', 'readonly', 'writeonly', 'coherent', 'volatile', 'restrict', 'shared', 'sample', 'patch', 'buffer'])
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='])
// binary operators, loosest first
const LEVELS = [['||'], ['^^'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']]

export function parseProgram(t: Tok[]): Program {
  let p = 0
  const structs = new Set<string>()
  const peek = (o = 0) => t[Math.min(p + o, t.length - 1)]
  const is = (v: string, o = 0) => peek(o).v === v && peek(o).k !== 'num'
  const next = () => t[Math.min(p++, t.length - 1)]
  const err = (m: string, at: Tok = peek()): never => { throw new CodeError(m, at.line, at.col) }
  const expect = (v: string, what = `"${v}"`) => {
    if (!is(v)) {
      const at = peek()
      if (v === ';' && p > 0) { const prev = t[p - 1]; err(`a ";" is missing at the end of this line.`, prev) }
      err(`expected ${what} here${at.k === 'eof' ? ', but the code ended' : `, found "${at.v}"`}.`)
    }
    return next()
  }
  const isType = (o = 0) => peek(o).k === 'id' && (BASIC.has(peek(o).v) || structs.has(peek(o).v))
  const name = (what: string) => { const x = next(); if (x.k !== 'id') err(`expected ${what} here, found "${x.v}".`, x); return x }

  function quals(): string[] {
    const q: string[] = []
    while (true) {
      if (peek().k === 'id' && QUALS.has(peek().v)) { q.push(next().v); continue }
      if (is('layout')) { next(); expect('('); let d = 1; while (d > 0) { const x = next(); if (x.k === 'eof') err('layout( is never closed.'); if (x.v === '(') d++; if (x.v === ')') d-- } continue }
      if (is('precision')) { return ['precision'] }
      return q
    }
  }
  function arrDims(): (Expr | null)[] {
    const dims: (Expr | null)[] = []
    while (is('[')) { next(); if (is(']')) { next(); dims.push(null) } else { dims.push(expr()); expect(']') } }
    return dims
  }
  function typeName(): TypeName {
    const x = peek()
    if (!isType()) err(`expected a type such as float or vec3 here, found "${x.v}".`)
    next()
    return { name: x.v, arr: arrDims(), line: x.line }
  }
  function structDef(): StructDef {
    const kw = next() // struct
    const nm = name('a name for the struct')
    structs.add(nm.v)
    expect('{')
    const fields: StructDef['fields'] = []
    while (!is('}')) {
      quals()
      const ty = typeName()
      do {
        const fn = name('a field name')
        const dims = arrDims()
        fields.push({ type: { ...ty, arr: [...ty.arr, ...dims] }, name: fn.v })
      } while (is(',') && next())
      expect(';')
    }
    next()
    return { name: nm.v, fields, line: kw.line }
  }
  function declRest(ty: TypeName, q: string[], first: Tok): Extract<Stmt, { k: 'decl' }> {
    const vars: VarDecl[] = []
    let nm = first
    while (true) {
      const dims = arrDims()
      let init: Expr | undefined
      if (is('=')) { next(); init = is('{') ? initList() : assignment() }
      vars.push({ name: nm.v, arr: dims, init, line: nm.line, col: nm.col })
      if (!is(',')) break
      next()
      nm = name('a variable name')
    }
    return { k: 'decl', type: ty, quals: q, vars, line: first.line }
  }
  function initList(): Expr {
    const o = expect('{')
    const list: Expr[] = []
    while (!is('}')) { list.push(is('{') ? initList() : assignment()); if (!is('}')) expect(',') }
    next()
    return { k: 'init', list, line: o.line, col: o.col }
  }

  // ---- expressions
  function expr(): Expr {
    const first = assignment()
    if (!is(',')) return first
    const list = [first]
    while (is(',')) { next(); list.push(assignment()) }
    return { k: 'seq', list, line: first.line, col: first.col }
  }
  function assignment(): Expr {
    const a = ternary()
    if (peek().k === 'op' && ASSIGN.has(peek().v)) {
      const o = next()
      const b = assignment()
      return { k: 'assign', op: o.v, a, b, line: o.line, col: o.col }
    }
    return a
  }
  function ternary(): Expr {
    const c = binary(0)
    if (!is('?')) return c
    const q = next()
    const a = assignment()
    expect(':', '":" for the other choice of ?')
    const b = assignment()
    return { k: 'cond', c, a, b, line: q.line, col: q.col }
  }
  function binary(l: number): Expr {
    if (l >= LEVELS.length) return unary()
    let a = binary(l + 1)
    while (peek().k === 'op' && LEVELS[l].includes(peek().v)) {
      const o = next()
      a = { k: 'bin', op: o.v, a, b: binary(l + 1), line: o.line, col: o.col }
    }
    return a
  }
  function unary(): Expr {
    const x = peek()
    if (x.k === 'op' && ['-', '+', '!', '~', '++', '--'].includes(x.v)) { next(); return { k: 'un', op: x.v, a: unary(), line: x.line, col: x.col } }
    return postfix()
  }
  function postfix(): Expr {
    let e = primary()
    while (true) {
      const x = peek()
      if (is('.')) {
        next()
        const f = name('a field or .xyz after the dot')
        if (is('(')) { const a = callArgs(); e = { k: 'call', fn: '.' + f.v, args: [e, ...a], line: f.line, col: f.col }; continue }
        e = { k: 'field', a: e, name: f.v, line: f.line, col: f.col }
        continue
      }
      if (is('[')) { next(); const i = expr(); expect(']'); e = { k: 'index', a: e, i, line: x.line, col: x.col }; continue }
      if (is('++') || is('--')) { next(); e = { k: 'post', op: x.v, a: e, line: x.line, col: x.col }; continue }
      return e
    }
  }
  function callArgs(): Expr[] {
    expect('(')
    const a: Expr[] = []
    if (is('void') && is(')', 1)) { next() }
    if (!is(')')) { a.push(assignment()); while (is(',')) { next(); a.push(assignment()) } }
    expect(')')
    return a
  }
  function primary(): Expr {
    const x = peek()
    if (x.k === 'num') { next(); return { k: 'num', v: x.v, line: x.line, col: x.col } }
    if (is('(')) { next(); const e = expr(); expect(')'); return e }
    if (x.k === 'id') {
      next()
      if (x.v === 'true' || x.v === 'false') return { k: 'num', v: x.v === 'true' ? '1' : '0', line: x.line, col: x.col }
      // array constructors: float[3](a, b, c) or float[](a, b, c)
      if (is('[') && (BASIC.has(x.v) || structs.has(x.v))) {
        const save = p
        const dims = arrDims()
        if (is('(')) return { k: 'call', fn: x.v, arr: dims, args: callArgs(), line: x.line, col: x.col }
        p = save
      }
      if (is('(')) return { k: 'call', fn: x.v, args: callArgs(), line: x.line, col: x.col }
      return { k: 'id', name: x.v, line: x.line, col: x.col }
    }
    if (x.k === 'eof') return err('the code ended in the middle of a line. Check for a missing ")" or "}".')
    return err(`did not expect "${x.v}" here.`)
  }

  // ---- statements
  function statement(): Stmt {
    const x = peek()
    if (is('{')) { next(); const list: Stmt[] = []; while (!is('}')) { if (peek().k === 'eof') err('a "{" is never closed with "}".', x); list.push(statement()) } next(); return { k: 'block', list, line: x.line } }
    if (is(';')) { next(); return { k: 'empty', line: x.line } }
    if (is('if')) {
      next(); expect('('); const c = expr(); expect(')')
      const a = statement()
      let b: Stmt | undefined
      if (is('else')) { next(); b = statement() }
      return { k: 'if', c, a, b, line: x.line }
    }
    if (is('for')) {
      next(); expect('(')
      let init: Stmt | undefined
      if (!is(';')) init = simple(); else next()
      const c = is(';') ? undefined : expr(); expect(';')
      const step = is(')') ? undefined : expr(); expect(')')
      return { k: 'for', init, c, step, body: statement(), line: x.line }
    }
    if (is('while')) { next(); expect('('); const c = expr(); expect(')'); return { k: 'while', c, body: statement(), line: x.line } }
    if (is('do')) { next(); const body = statement(); expect('while'); expect('('); const c = expr(); expect(')'); expect(';'); return { k: 'do', c, body, line: x.line } }
    if (is('switch')) {
      next(); expect('('); const e = expr(); expect(')'); expect('{')
      const cases: { v: Expr | null; body: Stmt[]; line: number }[] = []
      while (!is('}')) {
        const c = peek()
        if (is('case')) { next(); const v = ternary(); expect(':'); cases.push({ v, body: [], line: c.line }) }
        else if (is('default')) { next(); expect(':'); cases.push({ v: null, body: [], line: c.line }) }
        else { if (!cases.length) err('a switch starts with "case".'); if (peek().k === 'eof') err('a switch is never closed with "}".', x); cases[cases.length - 1].body.push(statement()) }
      }
      next()
      return { k: 'switch', e, cases, line: x.line }
    }
    if (is('break') || is('continue') || is('discard')) { next(); expect(';'); return { k: x.v as 'break', line: x.line } }
    if (is('return')) { next(); if (is(';')) { next(); return { k: 'return', line: x.line } } const e = expr(); expect(';'); return { k: 'return', e, line: x.line } }
    return simple()
  }
  // a declaration or an expression, ending with ";"
  function simple(): Stmt {
    const x = peek()
    const save = p
    const q = quals()
    if (is('struct')) { const s = structDef(); if (is(';')) { next(); return { k: 'empty', line: x.line } } return declRest({ name: s.name, arr: [], line: x.line }, q, name('a variable name')) }
    if (isType() && (peek(1).k === 'id' || (is('[', 1)))) {
      const ty = typeName()
      if (peek().k === 'id') { const d = declRest(ty, q, next()); expect(';'); return d }
      p = save
    } else if (q.length) {
      if (isType()) { const ty = typeName(); const d = declRest(ty, q, name('a variable name')); expect(';'); return d }
      p = save
    }
    const e = expr()
    expect(';')
    return { k: 'expr', e, line: x.line }
  }

  // ---- top level
  const globals: Global[] = []
  while (peek().k !== 'eof') {
    const x = peek()
    if (is(';')) { next(); continue }
    const q = quals()
    if (q[0] === 'precision') { while (!is(';')) next(); next(); continue }
    if (is('struct')) {
      const s = structDef()
      globals.push({ k: 'struct', s })
      if (!is(';')) { const d = declRest({ name: s.name, arr: [], line: x.line }, q, name('a variable name')); globals.push({ k: 'decl', d }) }
      expect(';')
      continue
    }
    // uniform blocks: uniform Name { float a; ... } inst;
    if (peek().k === 'id' && !isType() && is('{', 1) && q.length) {
      const bn = next()
      next()
      const ds: Extract<Stmt, { k: 'decl' }>[] = []
      while (!is('}')) { const fq = quals(); const ty = typeName(); const d = declRest(ty, [...q, ...fq], name('a field name')); expect(';'); ds.push(d) }
      next()
      if (peek().k === 'id') next()
      expect(';')
      globals.push({ k: 'block', name: bn.v, d: ds, line: bn.line })
      continue
    }
    if (!isType()) {
      if (x.k === 'id' && is('(', 1)) err(`"${x.v}(" here looks like a function, but it has no return type. Put one in front, such as: void ${x.v}(...) or float ${x.v}(...).`)
      err(`did not expect "${x.v}" here. The top of a shader holds uniforms, functions and constants.`)
    }
    const ty = typeName()
    if (q.length && is(';')) { next(); continue } // "in vec2;" with no name, or "precision"
    const nm = name('a name')
    if (is('(')) {
      next()
      const params: FnParam[] = []
      if (is('void') && is(')', 1)) next()
      while (!is(')')) {
        const pq = quals()
        const pt = typeName()
        let pn = ''
        if (peek().k === 'id') pn = next().v
        const dims = arrDims()
        params.push({ q: pq.includes('inout') ? 'inout' : pq.includes('out') ? 'out' : 'in', type: { ...pt, arr: [...pt.arr, ...dims] }, name: pn, isConst: pq.includes('const') })
        if (is(',')) next(); else if (!is(')')) err('expected "," or ")" between function inputs.')
      }
      next()
      if (is(';')) { next(); continue } // a forward declaration
      expect('{', '"{" to start the function')
      const body: Stmt[] = []
      while (!is('}')) { if (peek().k === 'eof') err(`the function ${nm.v}() is never closed with "}".`, nm); body.push(statement()) }
      next()
      globals.push({ k: 'fn', f: { ret: ty, name: nm.v, params, body, line: nm.line } })
      continue
    }
    const d = declRest(ty, q, nm)
    expect(';')
    globals.push({ k: 'decl', d })
  }
  return { globals }
}
