// Parity test, Godot side: runs real Godot 4 (OpenGL renderer) on each shader and compares with Blender's bake.
//   node test/godot_parity.ts <blender.json> <godot binary> <work dir>
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { check, toGodot } from '../src/index.ts'

const [bakeFile, godot, work, graphDir = 'examples'] = process.argv.slice(2)
const bake = JSON.parse(fs.readFileSync(bakeFile, 'utf8'))
const graphs = Object.fromEntries(fs.readdirSync(graphDir).map((f) => { const g = JSON.parse(fs.readFileSync(graphDir + '/' + f, 'utf8')); return [g.name, g] }))
fs.mkdirSync(work, { recursive: true })
const job: any[] = []
const names = Object.keys(bake)
for (const [k, name] of names.entries()) {
  const b = bake[name]
  const shader = path.resolve(work, `s${k}.gdshader`)
  fs.writeFileSync(shader, toGodot(check(graphs[name]), { bakeUV: true }))
  // Blender world matrix (row major) to Godot space: A * M * A^-1 with A: (x, y, z) -> (x, z, -y)
  const M = b.mesh.matrix as number[][]
  const A = [[1, 0, 0], [0, 0, 1], [0, -1, 0]], Ai = [[1, 0, 0], [0, 0, -1], [0, 1, 0]]
  const mul = (X: number[][], Y: number[][]) => X.map((r) => Y[0].map((_, j) => r.reduce((s, v, i) => s + v * Y[i][j], 0)))
  const R = mul(mul(A, M.slice(0, 3).map((r) => r.slice(0, 3))), Ai)
  const o = mul(A, M.slice(0, 3).map((r) => [r[3]]))
  job.push({ mesh: b.mesh, shader, out: path.resolve(work, `s${k}.raw`), xform: [R[0][0], R[1][0], R[2][0], R[0][1], R[1][1], R[2][1], R[0][2], R[1][2], R[2][2], o[0][0], o[1][0], o[2][0]] })
}
fs.writeFileSync(path.join(work, 'job.json'), JSON.stringify(job))
const log = execFileSync('xvfb-run', ['-a', '-s', '-screen 0 640x480x24', godot, '--path', path.resolve('test/godot'), ...(process.env.GODOT_ARGS ?? '--rendering-driver opengl3').split(' '), '-s', 'bake.gd', '--', path.resolve(work, 'job.json')], { encoding: 'utf8', stdio: 'pipe', timeout: 300000 })
const errs = log.split('\n').filter((l) => /error|SHADER/i.test(l))
if (errs.length) console.log(errs.slice(0, 20).join('\n'))
const report: any[] = []
for (const [k, name] of names.entries()) {
  const b = bake[name], size = b.size
  const blend = new Float32Array(Buffer.from(b.pixels, 'base64').buffer.slice(0))
  const raw = fs.readFileSync(path.join(work, `s${k}.raw`))
  const g = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4)
  let n = 0, same = 0, close = 0, max = 0, sum = 0
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4, j = i // same row order once the UV flip in the shader is undone
    if (!(blend[i + 3] > 0.5 && g[j + 3] > 0.5)) continue
    n++
    // as shown on screen: anything past 1 is white either way (glow shaders go far past it)
    const c = (v: number) => Math.min(1, Math.max(0, v))
    const d = Math.max(Math.abs(c(blend[i]) - c(g[j])), Math.abs(c(blend[i + 1]) - c(g[j + 1])), Math.abs(c(blend[i + 2]) - c(g[j + 2])))
    max = Math.max(max, d); sum += d; if (d < 0.5 / 255) same++; if (d < 2 / 255) close++
  }
  const row = { engine: 'Godot 4.5.1 ' + (process.env.GODOT_ARGS?.includes('vulkan') ? 'Forward+ (Vulkan)' : 'Compatibility (OpenGL)'), shader: name, texels: n, identical_8bit: `${(100 * same / n).toFixed(3)}%`, within_2_of_255: `${(100 * close / n).toFixed(3)}%`, mean_diff: (sum / n).toExponential(2), max_diff: max.toExponential(2) }
  report.push(row); console.log(row)
}
fs.writeFileSync(path.join(work, 'godot-parity.json'), JSON.stringify(report, null, 2))
