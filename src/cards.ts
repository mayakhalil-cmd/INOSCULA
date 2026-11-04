// Brush cards: small curved strips laid over a model, each one a single brush stroke. They sit just off the
// surface, follow the form and overlap, so strokes stand out past the silhouette and the model reads as painted
// in 3D. A shader draws the stroke on each card (see looks/oil-strokes.inoscula).
//
// Cards are ordinary geometry, so they travel in the model file to every tool. Their UVs carry the stroke:
// u runs along the stroke from CARD_U to CARD_U + 1 plus a whole number per card (so a shader can give each
// stroke its own value with floor(u)), v runs across it from 0 to 1. Normals are the surface normal under the
// middle of the card, so each stroke is lit as one flat painted plane.

export const CARD_U = 100 // u of the first card; a model's own UVs are far below this

export interface CardOptions {
  /** Number of strokes. */
  count?: number
  /** Stroke length, as a fraction of the model's size. */
  length?: number
  /** Stroke width, as a fraction of its length. */
  width?: number
  /** How far the cards float off the surface, as a fraction of the stroke width. */
  lift?: number
  /** 0: strokes wrap around the form, 1: every stroke points its own way. */
  scatter?: number
  /** Up axis of the model: 1 for Y up (glTF, three.js, RICO), 2 for Z up (Blender). */
  up?: 1 | 2
  seed?: number
}

export interface Cards { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array }

type V = [number, number, number]
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mul = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: V): V => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l] }

/** Surface area of a triangle mesh in its own units, for sharing strokes between the meshes of a model. */
export function meshArea(pos: ArrayLike<number>, idx: ArrayLike<number> | null, scale = 1): number {
  const tris = idx ? idx.length / 3 : pos.length / 9
  let a = 0
  for (let t = 0; t < tris; t++) {
    const i = (k: number) => (idx ? idx[t * 3 + k] : t * 3 + k) * 3
    const p0: V = [pos[i(0)], pos[i(0) + 1], pos[i(0) + 2]], p1: V = [pos[i(1)], pos[i(1) + 1], pos[i(1) + 2]], p2: V = [pos[i(2)], pos[i(2) + 1], pos[i(2) + 2]]
    a += Math.hypot(...cross(sub(p1, p0), sub(p2, p0))) / 2
  }
  return a * scale * scale
}

/** Lays brush cards over a triangle mesh (positions and normals per vertex, optional index list). */
export function brushCards(pos: ArrayLike<number>, nrm: ArrayLike<number>, idx: ArrayLike<number> | null, o: CardOptions = {}): Cards {
  const count = o.count ?? 1800, scatter = o.scatter ?? 0.35, upAxis = o.up ?? 1
  let seed = (o.seed ?? 7) >>> 0
  const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const P = (i: number): V => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]
  const N = (i: number): V => [nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]]
  const tris = idx ? idx.length / 3 : pos.length / 9
  const T = (t: number, k: number) => (idx ? idx[t * 3 + k] : t * 3 + k)

  // size of the model, and triangle areas for even sampling
  let lo: V = [Infinity, Infinity, Infinity], hi: V = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < pos.length / 3; i++) { const p = P(i); lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1]), Math.min(lo[2], p[2])]; hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1]), Math.max(hi[2], p[2])] }
  const size = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1
  const centre = mul(add(lo, hi), 0.5)
  const area = new Float64Array(tris)
  let total = 0
  for (let t = 0; t < tris; t++) { const a = P(T(t, 0)); total += Math.hypot(...cross(sub(P(T(t, 1)), a), sub(P(T(t, 2)), a))) / 2; area[t] = total }

  const len = (o.length ?? 0.09) * size, wid = len * (o.width ?? 0.32), lift = wid * (o.lift ?? 0.12)
  const SEG = 4 // segments along each stroke, so it can bend with the form
  const outP: number[] = [], outN: number[] = [], outU: number[] = [], outI: number[] = []
  const up: V = upAxis === 2 ? [0, 0, 1] : [0, 1, 0]
  for (let c = 0; c < count; c++) {
    // a point on the surface, evenly by area
    const r = rnd() * total
    let a = 0, b = tris - 1
    while (a < b) { const m = (a + b) >> 1; if (area[m] < r) a = m + 1; else b = m }
    let u = rnd(), v = rnd(); if (u + v > 1) { u = 1 - u; v = 1 - v }
    const i0 = T(a, 0), i1 = T(a, 1), i2 = T(a, 2)
    const p = add(add(mul(P(i0), 1 - u - v), mul(P(i1), u)), mul(P(i2), v))
    const n = norm(add(add(mul(N(i0), 1 - u - v), mul(N(i1), u)), mul(N(i2), v)))
    // direction: around the form, turned a little (or a lot, with scatter)
    let around = cross(up, n)
    if (dot(around, around) < 1e-4) around = cross([1, 0, 0], n)
    around = norm(around)
    const side = cross(n, around)
    const ang = (rnd() - 0.5) * (0.6 + scatter * 2.6)
    const dir = norm(add(mul(around, Math.cos(ang)), mul(side, Math.sin(ang))))
    const acr = cross(n, dir)
    // how strongly the surface curves here, guessed from the distance to the middle of the model
    const radius = Math.max(Math.hypot(...sub(p, centre)), len * 0.5)
    const L = len * (0.7 + rnd() * 0.6), W = wid * (0.75 + rnd() * 0.5), lift1 = lift * (0.5 + rnd())
    const id = Math.floor(rnd() * 64)
    const base = outP.length / 3
    for (let s = 0; s <= SEG; s++) {
      const f = s / SEG - 0.5
      const along = f * L
      const drop = (along * along) / (2 * radius) // bend down with the surface
      const mid = add(add(p, mul(dir, along)), mul(n, lift1 - drop))
      for (const k of [-0.5, 0.5]) {
        const q = add(mid, mul(acr, k * W))
        outP.push(q[0], q[1], q[2]); outN.push(n[0], n[1], n[2])
        outU.push(CARD_U + id + s / SEG, k + 0.5)
      }
    }
    for (let s = 0; s < SEG; s++) { const i = base + s * 2; outI.push(i, i + 2, i + 3, i, i + 3, i + 1) /* facing out, along the surface normal */ }
  }
  return { positions: new Float32Array(outP), normals: new Float32Array(outN), uvs: new Float32Array(outU), indices: new Uint32Array(outI) }
}

export const SHELL_U = 200 // u of shell copies: 200 = outer rim, 201 and 202 = offset outlines

export interface ShellOptions {
  /** How far the outer rim is inflated, as a fraction of the model's size. */
  rim?: number
  /** How far the two offset outlines are inflated, as a fraction of the model's size. */
  outline?: number
  /** How far each outline is shifted off centre, as a fraction of the model's size. */
  offset?: number
  seed?: number
}

/** The outer rim and two offset outlines: copies of the mesh inflated along its smooth normals (so sharp
 *  edges stay closed), the outlines also shifted a little at random. Normals point inwards, so a shader keeps
 *  only the far side, the part that shows around the silhouette (the inverted-hull trick). The copies are
 *  meant to use the same material as the mesh: u tells them apart (200 rim, 201 and 202 outlines). */
export function paintShells(pos: ArrayLike<number>, nrm: ArrayLike<number>, idx: ArrayLike<number> | null, o: ShellOptions = {}): Cards {
  const n = pos.length / 3
  // smooth normals: average the normals of every vertex at the same position
  const key = (i: number) => `${Math.round(pos[i * 3] * 1e4)},${Math.round(pos[i * 3 + 1] * 1e4)},${Math.round(pos[i * 3 + 2] * 1e4)}`
  const acc = new Map<string, V>()
  for (let i = 0; i < n; i++) { const k = key(i), a = acc.get(k) ?? [0, 0, 0]; acc.set(k, add(a, [nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]])) }
  let lo: V = [Infinity, Infinity, Infinity], hi: V = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < n; i++) { lo = [Math.min(lo[0], pos[i * 3]), Math.min(lo[1], pos[i * 3 + 1]), Math.min(lo[2], pos[i * 3 + 2])]; hi = [Math.max(hi[0], pos[i * 3]), Math.max(hi[1], pos[i * 3 + 1]), Math.max(hi[2], pos[i * 3 + 2])] }
  const size = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1
  let seed = (o.seed ?? 11) >>> 0
  const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const shells: [number, number, V][] = [[o.rim ?? 0.02, 0, [0, 0, 0]]]
  for (let k = 1; k <= 2; k++) shells.push([(o.outline ?? 0.04) * (0.8 + 0.4 * rnd()), k, mul(norm([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]), (o.offset ?? 0.02) * size)])
  const P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = []
  const tri = idx ? Array.from(idx) : Array.from({ length: n }, (_, i) => i)
  for (const [inflate, kind, off] of shells) {
    const base = P.length / 3
    for (let i = 0; i < n; i++) {
      const s = norm(acc.get(key(i))!)
      P.push(pos[i * 3] + s[0] * inflate * size + off[0], pos[i * 3 + 1] + s[1] * inflate * size + off[1], pos[i * 3 + 2] + s[2] * inflate * size + off[2])
      N.push(-s[0], -s[1], -s[2])
      U.push(SHELL_U + kind + 0.5, 0.5)
    }
    for (let t = 0; t < tri.length; t += 3) I.push(base + tri[t], base + tri[t + 2], base + tri[t + 1])
  }
  return { positions: new Float32Array(P), normals: new Float32Array(N), uvs: new Float32Array(U), indices: new Uint32Array(I) }
}
