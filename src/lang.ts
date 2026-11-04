// Inoscula code: write a shader as text, the way you would in GLSL, and get a Inoscula graph (and so native nodes in
// every tool). It also prints any graph back out as code, so nodes and code are two views of one shader.
//
//   name "Ink Wash";
//   uniform vec3 paper = vec3(0.93, 0.89, 0.80);   // @color @label Paper
//   uniform float scale = 3.0;                       // @range 0.5 20 @label Grain Scale
//   void main() {
//     float n = noise(object_pos, scale, 4.5, 0.55, 2.0);
//     color = mix(vec3(0.08, 0.1, 0.22), paper, n);
//   }
//
// No loops and no if blocks: Blender's nodes cannot loop, so a shader that loops could not travel. Use mix(),
// step(), smoothstep() and ?: instead, which every tool can build.
import { check, InosculaError, OPS, type Graph, type Lit, type Node, type Param, type Wire } from './spec.ts'

export class CodeError extends InosculaError {
  line: number
  col: number
  constructor(msg: string, line: number, col = 0) { super(`Line ${line}: ${msg}`); this.line = line; this.col = col }
}

// ---------------------------------------------------------------- tokens
type Tok = { k: 'num' | 'id' | 'str' | 'op' | 'eof'; v: string; line: number; col: number; note?: string }

function lex(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0, line = 1, col = 1
  const adv = (n: number) => { for (let k = 0; k < n; k++) { if (src[i] === '\n') { line++; col = 1 } else col++; i++ } }
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\n' || ch === ' ' || ch === '\t' || ch === '\r') { adv(1); continue }
    if (src.startsWith('//', i)) {
      const end = src.indexOf('\n', i), text = src.slice(i + 2, end < 0 ? src.length : end)
      const prev = out[out.length - 1]
      if (prev && prev.line === line && text.includes('@')) prev.note = (prev.note ?? '') + text
      adv((end < 0 ? src.length : end) - i); continue
    }
    if (src.startsWith('/*', i)) { const end = src.indexOf('*/', i + 2); adv((end < 0 ? src.length : end + 2) - i); continue }
    const at = { line, col }
    const num = /^(\d+\.?\d*(e[+-]?\d+)?|\.\d+(e[+-]?\d+)?)/i.exec(src.slice(i))
    if (num) { out.push({ k: 'num', v: num[0], ...at }); adv(num[0].length); continue }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))
    if (id) { out.push({ k: 'id', v: id[0], ...at }); adv(id[0].length); continue }
    if (ch === '"') { const end = src.indexOf('"', i + 1); if (end < 0) throw new CodeError('this text has no closing quote.', line, col); out.push({ k: 'str', v: src.slice(i + 1, end), ...at }); adv(end + 1 - i); continue }
    const two = src.slice(i, i + 2)
    if (['<=', '>=', '==', '!=', '+=', '-=', '*=', '/=', '&&', '||'].includes(two)) { out.push({ k: 'op', v: two, ...at }); adv(2); continue }
    if ('+-*/(),;=.?:<>{}[]!'.includes(ch)) { out.push({ k: 'op', v: ch, ...at }); adv(1); continue }
    throw new CodeError(`"${ch}" is not something Inoscula code understands.`, line, col)
  }
  out.push({ k: 'eof', v: '', line, col })
  return out
}

// ---------------------------------------------------------------- built in names
const BUILTINS: Record<string, string> = {
  uv: 'uv', object_pos: 'object_pos', world_pos: 'world_pos', normal: 'normal', object_normal: 'object_normal',
  view_dir: 'view_dir', time: 'time', light_dir: 'light_dir', light_color: 'light_color',
  curvature: 'curvature', occlusion: 'occlusion', object_size: 'object_size',
}
// what a shader can set. color and alpha always; the rest make it a lit (physically based) material
const OUTS = ['color', 'alpha', 'roughness', 'metallic', 'bump', 'emission', 'coat', 'coat_roughness', 'sheen', 'sheen_color', 'sheen_roughness', 'subsurface', 'outline', 'outline_color', 'outline_breakup', 'outline_rings']
const isOut = (s: string) => OUTS.includes(s)
const CONSTS: Record<string, number> = { PI: Math.PI, TAU: Math.PI * 2 }
// function name -> [op, input names in call order]
const CALLS: Record<string, [string, string[]]> = {
  sin: ['sin', ['x']], cos: ['cos', ['x']], abs: ['abs', ['x']], floor: ['floor', ['x']], fract: ['fract', ['x']],
  exp: ['exp', ['x']], sqrt: ['sqrt', ['x']], pow: ['pow', ['a', 'b']], min: ['min', ['a', 'b']], max: ['max', ['a', 'b']],
  clamp: ['clamp', ['x', 'lo', 'hi']], mix: ['mix', ['a', 'b', 't']], lerp: ['mix', ['a', 'b', 't']],
  smoothstep: ['smoothstep', ['e0', 'e1', 'x']], dot: ['dot', ['a', 'b']], length: ['length', ['x']],
  normalize: ['normalize', ['x']], one_minus: ['one_minus', ['x']], atan: ['atan2', ['y', 'x']], atan2: ['atan2', ['y', 'x']],
  noise: ['noise', ['p', 'scale', 'detail', 'roughness', 'lacunarity']], voronoi: ['voronoi', ['p', 'scale', 'randomness']], greater: ['greater', ['a', 'b']], white_noise: ['white_noise', ['p']], hash: ['white_noise', ['p']],
}

// ---------------------------------------------------------------- parser
type Val = Wire // a wire: node id, "node.port", "$param", number or [x, y, z]

/** For each graph parse() made: node id -> the code line it came from (Inoscula Studio uses it to link nodes to code). */
export const lineMap = new WeakMap<Graph, Map<string, number>>()

export function parse(src: string): Graph {
  const t = lex(src)
  let p = 0
  const peek = (o = 0) => t[p + o]
  const is = (v: string) => t[p].v === v && t[p].k !== 'str'
  const next = () => t[p++]
  const expect = (v: string, what = `"${v}"`) => { if (!is(v)) err(`expected ${what} here${t[p].k === 'eof' ? ', but the code ended' : `, found "${t[p].v}"`}.`); return next() }
  const err = (m: string, at = t[p]): never => { throw new CodeError(m, at.line, at.col) }

  let name = 'Untitled'
  const params: Param[] = []
  const nodes: Node[] = []
  const lineOf = new Map<string, number>()
  const vars = new Map<string, Val>()
  const seps = new Map<string, string>() // one Separate node per value, however many parts are read
  const ids = new Map<string, number>()
  const outs: Record<string, Val> = {}
  let shading: 'lit' | 'unlit' | undefined
  let surface: 'solid' | 'cutout' | undefined
  let cards: { count: number; length: number; width: number } | undefined
  let shells: { rim: number; outline: number; offset: number } | undefined
  const funcs = new Map<string, { params: string[]; start: number; line: number }>()
  const calling: string[] = []
  let curLine = 1

  const fresh = (base: string) => { const n = (ids.get(base) ?? 0) + 1; ids.set(base, n); return n === 1 ? base : `${base}_${n}` }
  const add = (op: string, ins: Record<string, Val>, base: string = op, set?: Record<string, unknown>): Val => {
    const id = fresh(base)
    const node: Node = { id, op }
    if (Object.keys(ins).length) node.in = ins
    if (set) node.set = set
    nodes.push(node); lineOf.set(id, curLine)
    return id
  }
  const isNum = (v: Val): v is number => typeof v === 'number'
  const isLit = (v: Val) => typeof v === 'number' || Array.isArray(v)
  const fold = (a: Val, b: Val, f: (x: number, y: number) => number): Val | null => {
    if (isNum(a) && isNum(b)) return f(a, b)
    if (isLit(a) && isLit(b)) { const A = isNum(a) ? [a, a, a] : a as number[], B = isNum(b) ? [b, b, b] : b as number[]; return A.map((x, i) => f(x, B[i])) as Lit }
    return null
  }

  // ---- expressions, lowest precedence first
  function expr(): Val { return ternary() }
  function ternary(): Val {
    const c = compare()
    if (!is('?')) return c
    next(); const a = expr(); expect(':'); const b = expr()
    return add('mix', { a: b, b: a, t: c }, 'pick')
  }
  function compare(): Val {
    let a = sum()
    while (['<', '>', '<=', '>='].includes(t[p].v) && t[p].k === 'op') {
      const op = next().v, b = sum()
      if (op === '>') a = add('greater', { a, b }, 'test')
      else if (op === '<') a = add('greater', { a: b, b: a }, 'test')
      else if (op === '>=') a = add('one_minus', { x: add('greater', { a: b, b: a }, 'test') }, 'test')
      else a = add('one_minus', { x: add('greater', { a, b }, 'test') }, 'test')
    }
    return a
  }
  function sum(): Val {
    let a = product()
    while ((is('+') || is('-')) && t[p].k === 'op') {
      const op = next().v, b = product()
      a = fold(a, b, op === '+' ? (x, y) => x + y : (x, y) => x - y) ?? add(op === '+' ? 'add' : 'sub', { a, b })
    }
    return a
  }
  function product(): Val {
    let a = unary()
    while ((is('*') || is('/')) && t[p].k === 'op') {
      const op = next().v, b = unary()
      a = fold(a, b, op === '*' ? (x, y) => x * y : (x, y) => (y === 0 ? 0 : x / y)) ?? add(op === '*' ? 'mul' : 'div', { a, b })
    }
    return a
  }
  function unary(): Val {
    if (is('-')) { next(); const v = unary(); return fold(0, v, (x, y) => x - y) ?? add('sub', { a: 0, b: v }, 'neg') }
    if (is('+')) { next(); return unary() }
    if (is('!')) err('"!" is not supported. Use one_minus(x) or 1.0 - x.')
    return postfix()
  }
  function postfix(): Val {
    let v = primary()
    while (is('.')) {
      next()
      const s = next()
      if (s.k !== 'id') err('expected x, y or z after the dot.', s)
      if ((s.v === 'color' || s.v === 'position') && typeof v === 'string' && nodes.find((n) => n.id === v)?.op === 'voronoi') { v = `${v}.${s.v}`; continue }
      const sw = s.v.replace(/r/g, 'x').replace(/g/g, 'y').replace(/b/g, 'z')
      if (sw === 'xyz') continue
      if (!/^[xyz]$/.test(sw)) err(`".${s.v}" is not available. Inoscula has single numbers and 3-part vectors, so use .x, .y, .z (or .r, .g, .b).`, s)
      if (Array.isArray(v)) { v = v['xyz'.indexOf(sw)]; continue }
      if (isNum(v)) continue
      const key = String(v)
      if (!seps.has(key)) seps.set(key, add('separate', { v }, 'parts') as string)
      v = `${seps.get(key)}.${sw}`
    }
    return v
  }
  function args(): Val[] {
    expect('(')
    const out: Val[] = []
    if (!is(')')) { out.push(expr()); while (is(',')) { next(); out.push(expr()) } }
    expect(')')
    return out
  }
  function primary(): Val {
    const tk = t[p]
    if (tk.k === 'num') { next(); return parseFloat(tk.v) }
    if (is('(')) { next(); const v = expr(); expect(')'); return v }
    if (tk.k !== 'id') err(tk.k === 'eof' ? 'the code ended in the middle of a line.' : `did not expect "${tk.v}" here.`)
    next()
    const id = tk.v
    if (is('(')) return call(id, tk)
    if (vars.has(id)) return vars.get(id)!
    if (id in CONSTS) return CONSTS[id]
    if (id in BUILTINS) { const key = '@' + id; if (!vars.has(key)) vars.set(key, add(BUILTINS[id], {}, id)); return vars.get(key)! }
    if (isOut(id)) { const v = outs[id]; if (v === undefined) err(`"${id}" is read before it is set.`, tk); return v }
    return err(`"${id}" is not defined. Declare it first, for example: float ${id} = 0.0;`, tk)
  }
  function call(fn: string, tk: Tok): Val {
    if (fn === 'vec3' || fn === 'float3' || fn === 'color3') {
      const a = args()
      if (a.length === 1) return isNum(a[0]) ? [a[0], a[0], a[0]] : (Array.isArray(a[0]) ? a[0] : add('combine', { x: a[0], y: a[0], z: a[0] }, 'vec'))
      if (a.length !== 3) err('vec3() takes 1 or 3 values.', tk)
      if (a.every(isNum)) return a as Lit
      return add('combine', { x: a[0], y: a[1], z: a[2] }, 'vec')
    }
    if (fn === 'float') { const a = args(); if (a.length !== 1) err('float() takes one value.', tk); return a[0] }
    if (fn === 'ramp') return ramp(tk)
    const a = args()
    const uf = funcs.get(fn)
    if (uf) return inline(fn, uf, a, tk)
    // shapes built from simpler nodes, so they still become plain nodes everywhere
    const need = (n: number) => { if (a.length !== n) err(`${fn}() takes ${n} value${n > 1 ? 's' : ''}.`, tk) }
    switch (fn) {
      case 'step': need(2); return add('one_minus', { x: add('greater', { a: a[0], b: a[1] }, 'step') }, 'step')
      case 'saturate': need(1); return add('clamp', { x: a[0], lo: 0, hi: 1 }, 'saturate')
      case 'mod': need(2); return add('sub', { a: a[0], b: add('mul', { a: a[1], b: add('floor', { x: add('div', { a: a[0], b: a[1] }, 'mod') }, 'mod') }, 'mod') }, 'mod')
      case 'reflect': need(2); return add('sub', { a: a[0], b: add('mul', { a: a[1], b: add('mul', { a: 2, b: add('dot', { a: a[1], b: a[0] }, 'reflect') }, 'reflect') }, 'reflect') }, 'reflect')
      case 'distance': need(2); return add('length', { x: add('sub', { a: a[0], b: a[1] }, 'distance') }, 'distance')
      case 'sign': need(1); return add('sub', { a: add('greater', { a: a[0], b: 0 }, 'sign'), b: add('greater', { a: 0, b: a[0] }, 'sign') }, 'sign')
      case 'radians': need(1); return isNum(a[0]) ? a[0] * Math.PI / 180 : add('mul', { a: a[0], b: Math.PI / 180 })
    }
    const c = CALLS[fn]
    if (!c) err(`"${fn}" is not a Inoscula function. Available: ${[...Object.keys(CALLS), 'vec3', 'ramp', 'step', 'saturate', 'mod', 'reflect', 'distance', 'sign', 'radians'].sort().join(', ')}.`, tk)
    const [op, names] = c
    const max = names.length, min = op === 'noise' ? 1 : max
    if (a.length < min || a.length > max) err(`${fn}() takes ${min === max ? max : `${min} to ${max}`} values.`, tk)
    const ins: Record<string, Val> = {}
    a.forEach((v, i) => { ins[names[i]] = v })
    if (op === 'noise') { const d = OPS.noise.ins; for (let i = a.length; i < d.length; i++) ins[d[i][0]] = d[i][2] as number }
    return add(op, ins)
  }
  function ramp(tk: Tok): Val {
    // ramp(t, "linear" | "constant", pos, vec3(...), pos, vec3(...), ...)
    expect('(')
    const tv = expr(); expect(',')
    const m = next()
    if (m.k !== 'str' || (m.v !== 'linear' && m.v !== 'constant')) err('the second value of ramp() is "linear" or "constant".', m)
    const stops: [number, number[]][] = []
    while (is(',')) {
      next()
      const pos = expr(); expect(',', 'a comma, then the colour for this stop')
      const col = expr()
      if (!isNum(pos) || !Array.isArray(col)) err('ramp() stops are fixed numbers and colours, such as 0.5, vec3(1.0, 0.2, 0.0).', tk)
      stops.push([pos as number, col as number[]])
    }
    expect(')')
    if (!stops.length) err('ramp() needs at least one stop.', tk)
    return add('ramp', { t: tv }, 'ramp', { mode: m.v, stops })
  }

  // ---- your own functions: copied in at each call, so they still become plain nodes everywhere
  function inline(fn: string, f: { params: string[]; start: number }, a: Val[], tk: Tok): Val {
    if (calling.includes(fn)) err(`${fn}() calls itself. Functions cannot repeat themselves, because nodes cannot loop.`, tk)
    if (a.length !== f.params.length) err(`${fn}() takes ${f.params.length} value${f.params.length === 1 ? '' : 's'}.`, tk)
    const saveP = p, saveVars = new Map(vars), saveLine = curLine
    // inside a function: its own parameters, plus the shader's uniforms and inputs
    for (const k of [...vars.keys()]) if (!(typeof vars.get(k) === 'string' && (String(vars.get(k)).startsWith('$') || k.startsWith('@')))) vars.delete(k)
    f.params.forEach((nm, i) => vars.set(nm, a[i]))
    calling.push(fn)
    p = f.start
    let result: Val | undefined
    while (true) {
      if (t[p].k === 'eof') err(`${fn}() has no "return".`)
      if (is('return')) { next(); result = expr(); expect(';'); expect('}', '"}" to close the function after return'); break }
      statement()
    }
    calling.pop()
    p = saveP; curLine = saveLine
    // inputs first read inside the function stay known, so the rest of the shader reuses the same node
    const inputs = [...vars].filter(([k]) => k.startsWith('@'))
    vars.clear(); for (const [k, v] of saveVars) vars.set(k, v)
    for (const [k, v] of inputs) if (!vars.has(k)) vars.set(k, v)
    return result!
  }
  function define() {
    next() // return type
    const nm = next()
    if (nm.v in CALLS || nm.v in BUILTINS || isOut(nm.v) || ['vec3', 'float', 'ramp', 'main'].includes(nm.v)) err(`"${nm.v}" is already a built-in name. Pick another name for your function.`, nm)
    expect('(')
    const params: string[] = []
    while (!is(')')) {
      const ty = next(); if (ty.v !== 'float' && ty.v !== 'vec3') err('function inputs are "float name" or "vec3 name".', ty)
      const pn = next(); if (pn.k !== 'id') err('expected an input name.', pn)
      params.push(pn.v)
      if (is(',')) next(); else if (!is(')')) err('expected "," or ")".')
    }
    next(); expect('{')
    funcs.set(nm.v, { params, start: p, line: nm.line })
    // skip the body for now; it is read at each call
    let depth = 1
    while (depth > 0) { const x = next(); if (x.k === 'eof') err(`the function ${nm.v}() is never closed with "}".`, nm); if (x.v === '{') depth++; else if (x.v === '}') depth-- }
  }

  // ---- statements
  function uniform() {
    const kw = next() // uniform
    const ty = next()
    if (ty.v !== 'float' && ty.v !== 'vec3') err('parameters are "uniform float" or "uniform vec3".', ty)
    const nm = next()
    if (nm.k !== 'id') err('expected a parameter name.', nm)
    let def: Val = ty.v === 'float' ? 0 : [0, 0, 0]
    if (is('=')) { next(); def = expr() }
    const semi = expect(';')
    const note = [kw, ty, nm, semi, t[p - 2]].map((x) => x.note ?? '').join(' ')
    if (ty.v === 'float' && !isNum(def)) err('a float parameter needs a plain number as its default.', nm)
    if (ty.v === 'vec3' && !(Array.isArray(def) || isNum(def))) err('a vec3 parameter needs a fixed vec3(...) as its default.', nm)
    const prm: Param = { id: nm.v, type: ty.v === 'float' ? 'float' : /@colou?r/.test(note) ? 'color' : 'vector', default: isNum(def) && ty.v === 'vec3' ? [def, def, def] : def as Lit }
    const range = /@range\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(note)
    if (range) { prm.min = parseFloat(range[1]); prm.max = parseFloat(range[2]) }
    const label = /@label\s+([^@]+)/.exec(note)
    if (label) prm.label = label[1].trim()
    params.push(prm)
    vars.set(nm.v, '$' + nm.v)
  }
  function statement() {
    const tk = t[p]
    curLine = tk.line
    if (is(';')) { next(); return }
    if (tk.v === 'if' || tk.v === 'for' || tk.v === 'while') err(`"${tk.v}" blocks cannot become nodes in every tool. Use mix(), step(), smoothstep() or "condition ? a : b" instead.`)
    if (tk.v === 'return') err(calling.length ? '"return" must be the last line of a function.' : 'set "color = ..." (and optionally "alpha = ...") instead of return.')
    if (tk.v === 'float' || tk.v === 'vec3') {
      next(); const nm = next()
      if (nm.k !== 'id') err('expected a variable name.', nm)
      if (nm.v in BUILTINS || isOut(nm.v)) err(`"${nm.v}" is a built-in name. Pick another name.`, nm)
      expect('='); const v = expr(); expect(';')
      vars.set(nm.v, name_(v, nm.v))
      return
    }
    if (tk.k === 'id' && ['=', '+=', '-=', '*=', '/='].includes(peek(1).v)) {
      next(); const op = next().v
      let v = expr(); expect(';')
      const cur = isOut(tk.v) ? outs[tk.v] : vars.get(tk.v)
      if (cur === undefined && (op !== '=' || !isOut(tk.v))) err(isOut(tk.v) ? `"${tk.v}" is changed before it is set.` : `"${tk.v}" is not declared. Start with: float ${tk.v} = ...;`, tk)
      if (op !== '=') v = add({ '+=': 'add', '-=': 'sub', '*=': 'mul', '/=': 'div' }[op]!, { a: cur!, b: v })
      if (isOut(tk.v)) outs[tk.v] = v
      else if (tk.v in BUILTINS) err(`"${tk.v}" is a built-in input and cannot be changed.`, tk)
      else vars.set(tk.v, name_(v, tk.v))
      return
    }
    err(`did not expect "${tk.v}" here.`)
  }
  // give the node that holds a variable the variable's name, so errors and Blender node labels read well
  function name_(v: Val, nm: string): Val {
    if (typeof v !== 'string' || v.startsWith('$') || v.includes('.')) return v
    const node = nodes.find((n) => n.id === v)
    if (!node || nodes.some((n) => n.id === nm)) return v
    // inside a function, keep the shader's shared inputs under their own names (the caller still knows them so)
    if (calling.length && Object.values(BUILTINS).includes(node.op)) return v
    const old = node.id
    node.id = fresh(nm)
    lineOf.set(node.id, lineOf.get(old) ?? curLine)
    for (const n of nodes) for (const k in n.in ?? {}) if (n.in![k] === old) n.in![k] = node.id
    for (const [k, x] of vars) if (x === old) vars.set(k, node.id)
    return node.id
  }

  while (t[p].k !== 'eof') {
    curLine = t[p].line
    if (is('name')) { next(); const s = next(); if (s.k !== 'str') err('write the name in quotes: name "My Shader";', s); name = s.v; expect(';'); continue }
    if (is('uniform')) { uniform(); continue }
    if (is('shading')) { next(); const m = next(); if (m.k !== 'str' || (m.v !== 'lit' && m.v !== 'unlit')) err('write shading "lit"; or shading "unlit";', m); shading = m.v as 'lit' | 'unlit'; expect(';'); continue }
    if (is('shells')) {
      const at = next(); const nums: number[] = []
      while (!is(';')) { const m = next(); if (m.k === 'eof') err('end the line with ;', at); if (m.v === ',') continue; const v = Number(m.v); if (Number.isNaN(v)) err('write shells rim, outline, offset; for example: shells 0.02, 0.04, 0.02;', m); nums.push(v) }
      expect(';'); if (nums.length !== 3) err('shells takes three numbers: rim inflate, outline inflate, outline offset.', at)
      shells = { rim: nums[0], outline: nums[1], offset: nums[2] }; continue
    }
    if (is('cards')) {
      const at = next(); const nums: number[] = []
      while (!is(';')) { const m = next(); if (m.k === 'eof') err('end the line with ;', at); if (m.v === ',') continue; const v = Number(m.v); if (Number.isNaN(v)) err('write cards count, length, width; for example: cards 3500, 0.06, 0.34;', m); nums.push(v) }
      expect(';'); if (nums.length !== 3 && nums.length !== 4) err('cards takes three or four numbers: count, length, width, and how far strokes float off the surface.', at)
      cards = { count: nums[0], length: nums[1], width: nums[2], ...(nums.length === 4 ? { lift: nums[3] } : {}) }; continue
    }
    if (is('surface')) { next(); const m = next(); if (m.k !== 'str' || (m.v !== 'solid' && m.v !== 'cutout')) err('write surface "cutout"; or surface "solid";', m); surface = m.v as 'solid' | 'cutout'; expect(';'); continue }
    if ((is('float') || is('vec3')) && peek(1).k === 'id' && peek(2).v === '(') { define(); continue }
    if (is('void')) {
      next(); const m = next(); if (m.v !== 'main') err('the shader body is "void main() { ... }".', m)
      expect('('); expect(')'); expect('{')
      while (!is('}')) { if (t[p].k === 'eof') err('"void main() {" is never closed with "}".'); statement() }
      next(); continue
    }
    statement()
  }
  if (outs.color === undefined) throw new CodeError('the shader never sets "color". Add a line like: color = vec3(1.0, 0.5, 0.2);', t[p].line)

  const graph: Graph = { inoscula: '0.1', name, params, nodes, output: { color: outs.color } }
  for (const k of OUTS.slice(1)) if (outs[k] !== undefined) (graph.output as Record<string, Val>)[k] = outs[k]
  const wantsLit = OUTS.slice(2, 12).some((k) => outs[k] !== undefined)
  if (shading === 'unlit' && wantsLit) throw new CodeError('roughness, metallic, bump and emission only exist in lit shading. Remove shading "unlit"; or remove those lines.', 1)
  if (shading ?? (wantsLit ? 'lit' : undefined)) graph.shading = shading ?? 'lit'
  if (surface === 'cutout') graph.surface = 'cutout'
  if (cards) graph.cards = cards
  if (shells) graph.shells = shells
  lineMap.set(graph, lineOf)
  // check now, so mistakes point at a line of code rather than at a node
  try { check(graph) } catch (e) {
    const m = /Node "([^"]+)"/.exec((e as Error).message)
    const line = m ? lineOf.get(m[1]) : undefined
    const msg = (e as Error).message.replace(/Node "[^"]+" \(([^)]+)\)/, '$1()').replace(/input "(\w+)"/, 'value "$1"')
    throw line ? new CodeError(msg, line) : e
  }
  return graph
}

// ---------------------------------------------------------------- graph -> code
const fmt = (x: number) => { const s = String(+x.toFixed(6)); return /[.e]/.test(s) ? s : s + '.0' }
const litCode = (v: Lit) => (typeof v === 'number' ? fmt(v) : `vec3(${v.map(fmt).join(', ')})`)
const NAMES: Record<string, string> = { atan2: 'atan2' }

/** Prints a graph as Inoscula code. Every node becomes one line, named after the node. */
export function toCode(g: Graph): string {
  const ir = check(g)
  const name = new Map<string, string>()
  const ident = (s: string) => { let b = s.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, 'n$1'); if (b in BUILTINS || b === 'color' || b === 'alpha' || b in CALLS) b += '_'; return b }
  const used = new Set<string>(ir.params.map((p) => p.id))
  for (const s of ir.steps) { let b = ident(s.node), k = 2; while (used.has(b)) b = `${ident(s.node)}_${k++}`; used.add(b); name.set(s.id, b) }
  const w = (a: { k: string; v?: Lit; id?: string }) => {
    if (a.k === 'lit') return litCode(a.v as Lit)
    const id = a.id!
    if (id.startsWith('p_')) return id.slice(2)
    const m = /^(v\d+)_([xyz])$/.exec(id)
    if (m) return `${name.get(m[1])}.${m[2]}`
    const mv = /^(v\d+)_(color|position)$/.exec(id)
    if (mv) return `${name.get(mv[1])}.${mv[2]}`
    return name.get(id)!
  }
  const lines = [`name "${ir.name}";`, ...(ir.lit ? ['shading "lit";'] : []), ...(ir.cutout ? ['surface "cutout";'] : []), ...(ir.source.shells ? [`shells ${ir.source.shells.rim}, ${ir.source.shells.outline}, ${ir.source.shells.offset};`] : []), ...(ir.source.cards ? [`cards ${ir.source.cards.count}, ${ir.source.cards.length}, ${ir.source.cards.width}${ir.source.cards.lift !== undefined ? ', ' + ir.source.cards.lift : ''};`] : []), '']
  for (const p of ir.params) {
    const notes = [p.type === 'color' ? '@color' : '', p.min !== undefined && p.max !== undefined ? `@range ${p.min} ${p.max}` : '', p.label ? `@label ${p.label}` : ''].filter(Boolean).join(' ')
    lines.push(`uniform ${p.t} ${p.id} = ${litCode(p.default)};${notes ? '  // ' + notes : ''}`)
  }
  lines.push('', 'void main() {')
  for (const s of ir.steps) {
    if (OPS[s.op].source) {
      if (s.op === 'value') lines.push(`  ${s.type} ${name.get(s.id)} = ${litCode(s.set.v as Lit)};`)
      else lines.push(`  ${s.type} ${name.get(s.id)} = ${s.op};`)
      continue
    }
    const a = s.args.map(w)
    let e: string
    if (s.op === 'ramp') {
      const st = s.set.stops as [number, number[]][]
      e = `ramp(${a[0]}, "${s.set.mode}", ${st.map(([p, c]) => `${fmt(p)}, ${litCode(c as Lit)}`).join(', ')})`
    } else if (s.op === 'separate') { lines.push(`  vec3 ${name.get(s.id)} = ${a[0]};`); continue }
    else if (s.op === 'combine') e = `vec3(${a.join(', ')})`
    else if (['add', 'sub', 'mul', 'div'].includes(s.op)) e = `${a[0]} ${{ add: '+', sub: '-', mul: '*', div: '/' }[s.op]} ${a[1]}`
    else e = `${NAMES[s.op] ?? s.op}(${a.join(', ')})`
    lines.push(`  ${s.type} ${name.get(s.id)} = ${e};`)
  }
  lines.push(`  color = ${w(ir.color)};`)
  if (ir.alpha) lines.push(`  alpha = ${w(ir.alpha)};`)
  if (ir.lit) {
    lines.push(`  roughness = ${w(ir.roughness)};`, `  metallic = ${w(ir.metallic)};`)
    if (ir.bump) lines.push(`  bump = ${w(ir.bump)};`)
    if (ir.emission) lines.push(`  emission = ${w(ir.emission)};`)
    for (const [k, a] of Object.entries(ir.layers)) if (a) lines.push(`  ${k} = ${w(a)};`)
  }
  if (ir.outline) lines.push(`  outline = ${w(ir.outline.width)};`, `  outline_color = ${w(ir.outline.color)};`, `  outline_breakup = ${w(ir.outline.breakup)};`, ...(ir.outline.rings ? [`  outline_rings = ${ir.outline.rings}.0;`] : []))
  lines.push('}')
  return lines.join('\n') + '\n'
}
