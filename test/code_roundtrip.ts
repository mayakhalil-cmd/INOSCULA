// Every shader turned into Inoscula code (Studio's "Turn into Inoscula code", and the code view of a graph) must
// read back as the very same nodes: same steps, same wires, same numbers as 32-bit floats.
// node test/code_roundtrip.ts
import fs from 'node:fs'
import { check, read } from '../src/index.ts'
import { parse, toCode } from '../src/lang.ts'
import type { Graph } from '../src/spec.ts'

const f32 = (v: unknown) => (typeof v === 'number' ? Math.fround(v) : v)
function shape(g: Graph): string {
  const ir = check(g)
  const pos = new Map(ir.steps.map((s, i) => [s.id, i]))
  const arg = (a: any) => {
    if (a.k === 'lit') return typeof a.v === 'number' ? Math.fround(a.v) : a.v.map(Math.fround)
    if (a.id.startsWith('p_')) return a.id
    const base = pos.has(a.id) ? a.id : a.id.replace(/_(x|y|z|color|position)$/, '')
    return '#' + pos.get(base) + a.id.slice(base.length)
  }
  return JSON.stringify([ir.steps.map((s) => [s.op, s.type, s.set, s.args.map(arg)]), arg(ir.color), ir.alpha && arg(ir.alpha), ir.params.map((p) => [p.id, p.default])], (_k, v) => f32(v))
}

const files = [
  ...fs.readdirSync('looks').map((f) => 'looks/' + f),
  ...fs.readdirSync('examples').filter((f) => f.endsWith('.json')).map((f) => 'examples/' + f),
  ...fs.readdirSync('test/glsl').map((f) => 'test/glsl/' + f),
  ...fs.readdirSync('test/hlsl').map((f) => 'test/hlsl/' + f),
]
let bad = 0
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8')
  const g: Graph = f.endsWith('.json') ? JSON.parse(t) : read(t, f.split('/').pop()).graph
  let ok = false
  try { ok = shape(g) === shape(parse(toCode(g))) } catch (e) { console.log(f.padEnd(40), 'does not read back:', (e as Error).message) }
  if (!ok) bad++
  console.log(f.padEnd(40), ok ? 'same' : 'DIFFERENT')
}
console.log(bad ? `${bad} of ${files.length} came back different` : `all ${files.length} came back the same`)
process.exit(bad ? 1 : 0)
