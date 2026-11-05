// GLSL text to tokens: comments, #define and #if, the way a GLSL compiler reads them first.
import { CodeError } from '../lang.ts'

export type Tok = { k: 'num' | 'id' | 'op' | 'eof'; v: string; line: number; col: number }

/** The // comment on each line, kept so "uniform float x; // @range 0 1" can still set the slider. */
export type Notes = Map<number, string>

const OPS3 = ['<<=', '>>=']
const OPS2 = ['++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '==', '!=', '<=', '>=', '&&', '||', '^^', '<<', '>>', '##']

function stripComments(src: string, notes: Notes): string {
  let out = '', i = 0, line = 1
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      let j = i + 2
      while (j < src.length && src[j] !== '\n') j++
      notes.set(line, (notes.get(line) ?? '') + ' ' + src.slice(i + 2, j))
      out += ' '
      i = j
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end < 0) throw new CodeError('a /* comment is never closed with */.', line)
      const body = src.slice(i + 2, end)
      notes.set(line, (notes.get(line) ?? '') + ' ' + body.replace(/\n/g, ' '))
      for (const ch of body) if (ch === '\n') { out += '\n'; line++ }
      out += ' '
      i = end + 2
    } else {
      if (c === '\n') line++
      out += c
      i++
    }
  }
  return out
}

function lexLine(text: string, line: number, out: Tok[]) {
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; continue }
    const col = i + 1
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      let j = i
      if (c === '0' && /[xX]/.test(text[i + 1] ?? '')) { j += 2; while (/[0-9a-fA-F]/.test(text[j] ?? '')) j++ }
      else {
        while (/[0-9]/.test(text[j] ?? '')) j++
        if (text[j] === '.') { j++; while (/[0-9]/.test(text[j] ?? '')) j++ }
        if (/[eE]/.test(text[j] ?? '') && /[-+0-9]/.test(text[j + 1] ?? '')) { j += 2; while (/[0-9]/.test(text[j] ?? '')) j++ }
      }
      while (/[uUfFlLhH]/.test(text[j] ?? '')) j++
      out.push({ k: 'num', v: text.slice(i, j), line, col })
      i = j
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (/[A-Za-z0-9_]/.test(text[j] ?? '')) j++
      out.push({ k: 'id', v: text.slice(i, j), line, col })
      i = j
      continue
    }
    const three = text.slice(i, i + 3), two = text.slice(i, i + 2)
    if (OPS3.includes(three)) { out.push({ k: 'op', v: three, line, col }); i += 3; continue }
    if (OPS2.includes(two)) { out.push({ k: 'op', v: two, line, col }); i += 2; continue }
    if ('+-*/%<>=!&|^~?:;,.(){}[]#'.includes(c)) { out.push({ k: 'op', v: c, line, col }); i++; continue }
    if (c === '"') throw new CodeError('GLSL has no text strings. Remove the quotes.', line, col)
    throw new CodeError(`the character "${c}" is not part of GLSL.`, line, col)
  }
}

export const numValue = (s: string): number => {
  const t = s.replace(/[uUfFlLhH]+$/, '')
  if (/^0[xX]/.test(t)) return parseInt(t, 16)
  if (/^0[0-7]+$/.test(t)) return parseInt(t, 8)
  return parseFloat(t)
}
export const isIntLit = (s: string) => !/[.eE]/.test(s.replace(/^0[xX][0-9a-fA-F]*/, '0')) && !/[fF]$/.test(s)

type Macro = { params: string[] | null; body: Tok[] }

/** What the reader needs from the text: the tokens after #define and #if, and the comment on each line. */
export function preprocess(src: string, predefined: Record<string, string> = {}): { toks: Tok[]; notes: Notes; version?: number } {
  const notes: Notes = new Map()
  src = src.replace(/\r\n?/g, '\n')
  // a backslash at the end of a line joins it to the next one; the extra line breaks go after, so line numbers hold
  src = src.replace(/\\\n((?:[^\n]*\\\n)*)([^\n]*)/g, (_m, mid: string, last: string) => {
    const n = 1 + (mid.match(/\n/g)?.length ?? 0)
    return ' ' + mid.replace(/\\\n/g, ' ') + last + '\n'.repeat(n)
  })
  src = stripComments(src, notes)
  const macros = new Map<string, Macro>()
  for (const [k, v] of Object.entries(predefined)) {
    // "NAME" or "NAME(a,b)", as a #define would have it
    const b: Tok[] = []; lexLine(v, 0, b)
    const fm = /^(\w+)\(([^)]*)\)$/.exec(k)
    if (fm) macros.set(fm[1], { params: fm[2].split(',').map((x) => x.trim()).filter(Boolean), body: b })
    else macros.set(k, { params: null, body: b })
  }
  const lines = src.split('\n')
  const out: Tok[] = []
  // each #if: is this branch on, has an earlier branch already been taken, was the whole #if inside an off branch
  const stack: { on: boolean; taken: boolean; parentOn: boolean; line: number }[] = []
  const active = () => stack.every((s) => s.on)
  let version: number | undefined
  const pending: Tok[] = []
  const flush = () => { if (pending.length) { out.push(...expand(pending.splice(0), macros, new Set(), 0)) } }

  lines.forEach((raw, idx) => {
    const line = idx + 1
    const m = /^\s*#\s*(\w*)\s*(.*)$/.exec(raw)
    if (!m) {
      if (!active()) return
      lexLine(raw, line, pending)
      return
    }
    const [, dir, rest] = m
    const lineToks = () => { const t: Tok[] = []; lexLine(rest, line, t); return t }
    switch (dir) {
      case 'if': case 'ifdef': case 'ifndef': {
        const parentOn = active()
        let on = false
        if (parentOn) {
          if (dir === 'if') on = evalIf(lineToks(), macros, line) !== 0
          else { const nm = /^(\w+)/.exec(rest)?.[1]; on = dir === 'ifdef' ? macros.has(nm ?? '') : !macros.has(nm ?? '') }
        }
        stack.push({ on, taken: on, parentOn, line })
        return
      }
      case 'elif': {
        const s = stack[stack.length - 1]
        if (!s) throw new CodeError('#elif without an #if above it.', line)
        if (s.taken || !s.parentOn) s.on = false
        else { stack.pop(); const on = active() && evalIf(lineToks(), macros, line) !== 0; stack.push(s); s.on = on; s.taken = on }
        return
      }
      case 'else': {
        const s = stack[stack.length - 1]
        if (!s) throw new CodeError('#else without an #if above it.', line)
        s.on = s.parentOn && !s.taken; s.taken = true
        return
      }
      case 'endif':
        if (!stack.pop()) throw new CodeError('#endif without an #if above it.', line)
        return
    }
    if (!active()) return
    switch (dir) {
      case 'define': {
        flush()
        const dm = /^(\w+)(\(([^)]*)\))?\s*(.*)$/.exec(rest)
        if (!dm) throw new CodeError('#define needs a name.', line)
        const body: Tok[] = []
        lexLine(dm[4], line, body)
        const params = dm[2] !== undefined ? dm[3].split(',').map((s) => s.trim()).filter(Boolean) : null
        macros.set(dm[1], { params, body })
        return
      }
      case 'undef': flush(); macros.delete(rest.trim()); return
      case 'version': version = parseInt(rest); return
      case 'extension': case 'pragma': case 'line': case '': return
      case 'error': throw new CodeError(`the shader stops itself here with #error ${rest.trim()}`, line)
      case 'include': throw new CodeError('#include is not available: paste the included file in place of this line.', line)
      default: throw new CodeError(`"#${dir}" is not a GLSL instruction.`, line)
    }
  })
  if (stack.length) throw new CodeError('this #if is never closed with #endif.', stack[stack.length - 1].line)
  flush()
  out.push({ k: 'eof', v: '', line: lines.length, col: 1 })
  return { toks: out, notes, version }
}

function expand(toks: Tok[], macros: Map<string, Macro>, hide: Set<string>, depth: number): Tok[] {
  if (depth > 64) throw new CodeError('a #define refers to itself too many times.', toks[0]?.line ?? 0)
  const out: Tok[] = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    const m = t.k === 'id' && !hide.has(t.v) ? macros.get(t.v) : undefined
    if (!m) { out.push(t); continue }
    const at = (b: Tok[]) => b.map((x) => ({ ...x, line: t.line, col: t.col }))
    if (m.params === null) {
      out.push(...expand(at(m.body), macros, new Set([...hide, t.v]), depth + 1))
      continue
    }
    if (toks[i + 1]?.v !== '(') { out.push(t); continue }
    // collect the arguments, split at top level commas
    const args: Tok[][] = [[]]
    let j = i + 2, level = 0
    for (; j < toks.length; j++) {
      const x = toks[j]
      if (x.v === '(' || x.v === '[' || x.v === '{') level++
      else if (x.v === ')' || x.v === ']' || x.v === '}') { if (level === 0 && x.v === ')') break; level-- }
      if (x.v === ',' && level === 0 && x.k === 'op') { args.push([]); continue }
      args[args.length - 1].push(x)
    }
    if (j >= toks.length) throw new CodeError(`the call to the #define ${t.v}(...) is never closed with ")".`, t.line, t.col)
    if (m.params.length === 0 && args.length === 1 && args[0].length === 0) args.length = 0
    if (args.length !== m.params.length) throw new CodeError(`the #define ${t.v} takes ${m.params.length} value${m.params.length === 1 ? '' : 's'}, but ${args.length} ${args.length === 1 ? 'is' : 'are'} given.`, t.line, t.col)
    const full = args.map((a) => expand(a, macros, hide, depth + 1))
    let body: Tok[] = []
    const b = m.body
    for (let k = 0; k < b.length; k++) {
      const x = b[k]
      const pi = x.k === 'id' ? m.params.indexOf(x.v) : -1
      if (b[k + 1]?.v === '##' || b[k - 1]?.v === '##') {
        // token pasting uses the raw argument
        body.push(...(pi >= 0 ? args[pi] : [x]))
      } else if (x.v === '#' && x.k === 'op') {
        throw new CodeError('# inside a #define (turning a value into text) is not available in shaders.', t.line, t.col)
      } else body.push(...(pi >= 0 ? full[pi] : [x]))
    }
    // join the two sides of each ##
    const joined: Tok[] = []
    for (let k = 0; k < body.length; k++) {
      if (body[k].v === '##' && joined.length && body[k + 1]) { const a = joined.pop()!; const c = body[++k]; const nt: Tok[] = []; lexLine(a.v + c.v, t.line, nt); joined.push(...nt) }
      else joined.push(body[k])
    }
    body = joined
    out.push(...expand(at(body), macros, new Set([...hide, t.v]), depth + 1))
    i = j
  }
  return out
}

function evalIf(toks: Tok[], macros: Map<string, Macro>, line: number): number {
  // defined(X) and defined X come first, before the names are replaced
  const pre: Tok[] = []
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].v === 'defined') {
      let nm: string | undefined
      if (toks[i + 1]?.v === '(') { nm = toks[i + 2]?.v; i += 3 } else { nm = toks[i + 1]?.v; i += 1 }
      pre.push({ k: 'num', v: macros.has(nm ?? '') ? '1' : '0', line, col: 0 })
    } else pre.push(toks[i])
  }
  const t = expand(pre, macros, new Set(), 0).map((x) => (x.k === 'id' ? { ...x, k: 'num' as const, v: x.v === 'true' ? '1' : '0' } : x))
  let p = 0
  const peek = () => t[p]?.v
  const fail = (): never => { throw new CodeError('this #if line could not be read. It should compare numbers, such as #if STEPS > 50.', line) }
  const prim = (): number => {
    const x = t[p++]
    if (!x) return fail()
    if (x.v === '(') { const v = tern(); if (t[p++]?.v !== ')') fail(); return v }
    if (x.v === '!') return prim() ? 0 : 1
    if (x.v === '-') return -prim()
    if (x.v === '+') return prim()
    if (x.v === '~') return ~prim()
    if (x.k === 'num') return numValue(x.v)
    return fail()
  }
  const levels: [string[], (a: number, b: number, o: string) => number][] = [
    [['||'], (a, b) => (a || b ? 1 : 0)], [['&&'], (a, b) => (a && b ? 1 : 0)],
    [['|'], (a, b) => a | b], [['^'], (a, b) => a ^ b], [['&'], (a, b) => a & b],
    [['==', '!='], (a, b, o) => ((o === '==') === (a === b) ? 1 : 0)],
    [['<', '>', '<=', '>='], (a, b, o) => ((o === '<' ? a < b : o === '>' ? a > b : o === '<=' ? a <= b : a >= b) ? 1 : 0)],
    [['<<', '>>'], (a, b, o) => (o === '<<' ? a << b : a >> b)],
    [['+', '-'], (a, b, o) => (o === '+' ? a + b : a - b)],
    [['*', '/', '%'], (a, b, o) => (o === '*' ? a * b : o === '/' ? Math.trunc(a / b) : a % b)],
  ]
  const bin = (l: number): number => {
    if (l >= levels.length) return prim()
    let a = bin(l + 1)
    while (levels[l][0].includes(peek() ?? '')) { const o = t[p++].v; a = levels[l][1](a, bin(l + 1), o) }
    return a
  }
  const tern = (): number => { const c = bin(0); if (peek() === '?') { p++; const a = tern(); if (t[p++]?.v !== ':') fail(); const b = tern(); return c ? a : b } return c }
  const v = tern()
  if (p !== t.length) fail()
  return v
}
