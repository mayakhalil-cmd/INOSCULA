// GLSL types, reduced to what the reader needs: how many parts a value has and how they are laid out.
export type Base = 'float' | 'int' | 'uint' | 'bool'
export type Ty =
  | { k: 'num'; b: Base; n: number } // n = 1 for a scalar, 2 to 4 for a vector
  | { k: 'mat'; c: number; r: number } // columns, rows
  | { k: 'struct'; name: string; fields: { name: string; t: Ty }[] }
  | { k: 'arr'; of: Ty; len: number }
  | { k: 'sampler' }
  | { k: 'void' }

export const F: Ty = { k: 'num', b: 'float', n: 1 }
export const I: Ty = { k: 'num', b: 'int', n: 1 }
export const B: Ty = { k: 'num', b: 'bool', n: 1 }
export const vec = (n: number, b: Base = 'float'): Ty => ({ k: 'num', b, n })

export function size(t: Ty): number {
  switch (t.k) {
    case 'num': return t.n
    case 'mat': return t.c * t.r
    case 'struct': return t.fields.reduce((s, f) => s + size(f.t), 0)
    case 'arr': return t.len * size(t.of)
    default: return 0
  }
}

export function show(t: Ty): string {
  switch (t.k) {
    case 'num': { const p = t.b === 'float' ? '' : t.b === 'int' ? 'i' : t.b === 'uint' ? 'u' : 'b'; return t.n === 1 ? t.b : `${p}vec${t.n}` }
    case 'mat': return t.c === t.r ? `mat${t.c}` : `mat${t.c}x${t.r}`
    case 'struct': return t.name
    case 'arr': return `${show(t.of)}[${t.len}]`
    case 'sampler': return 'sampler'
    case 'void': return 'void'
  }
}

export const eqTy = (a: Ty, b: Ty) => show(a) === show(b)

/** The type for a name such as vec3, ivec2 or mat3x2, or null. */
export function basic(name: string): Ty | null {
  if (name === 'float' || name === 'double') return F
  if (name === 'int') return I
  if (name === 'uint') return { k: 'num', b: 'uint', n: 1 }
  if (name === 'bool') return B
  if (name === 'void') return { k: 'void' }
  let m = /^([dibu]?)vec([234])$/.exec(name)
  if (m) return vec(+m[2], m[1] === 'i' ? 'int' : m[1] === 'u' ? 'uint' : m[1] === 'b' ? 'bool' : 'float')
  m = /^mat([234])(?:x([234]))?$/.exec(name)
  if (m) return { k: 'mat', c: +m[1], r: +(m[2] ?? m[1]) }
  if (/sampler/.test(name)) return { k: 'sampler' }
  return null
}
