// Parity test, RICO / three.js side. Draws the exact mesh Blender baked, flattened into UV space, with the
// shader Inoscula made for three.js (the same code RICO Engine runs), then compares every texel with Blender's bake.
//   node test/parity.mjs <blender.json> <three.module.js> <out_dir>
import fs from 'node:fs'
import http from 'node:http'
import { chromium } from 'playwright'
import { check, toThree } from '../src/index.ts'

const EXACT = process.argv.includes('--exact') // same inputs on both sides: tests the maths alone
// --differs a,b: shaders known to come out different in Blender (random numbers from fract(sin(x) * big), which
// each renderer rounds its own way). They are still drawn and listed, but do not fail the test.
const di = process.argv.indexOf('--differs')
const DIFFERS = new Set(di > 0 ? process.argv[di + 1].split(',') : [])
const [bakeFile, threeFile, outDir, graphDir = 'examples'] = process.argv.slice(2).filter((a, i, all) => a !== '--exact' && a !== '--differs' && all[i - 1] !== '--differs')
const bake = JSON.parse(fs.readFileSync(bakeFile, 'utf8'))
const graphs = Object.fromEntries(fs.readdirSync(graphDir).map((f) => { const g = JSON.parse(fs.readFileSync(graphDir + '/' + f, 'utf8')); return [g.name, g] }))

const page = `<!doctype html><canvas id=c width=256 height=256></canvas><script type=importmap>{"imports":{"three":"/three.js"}}</script>
<script type=module>
import * as THREE from 'three'
window.renderBake = (mesh, sh, size, inputs) => {
  const r = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: false })
  const rt = new THREE.WebGLRenderTarget(size, size, { type: THREE.FloatType, depthBuffer: false })
  // Blender (Z up) to three (Y up): (x, y, z) -> (x, z, -y)
  const A = new THREE.Matrix4().set(1,0,0,0, 0,0,1,0, 0,-1,0,0, 0,0,0,1)
  const conv = (a) => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i += 3) { o[i] = a[i]; o[i+1] = a[i+2]; o[i+2] = -a[i+1] } return o }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(conv(mesh.pos), 3))
  g.setAttribute('normal', new THREE.BufferAttribute(conv(mesh.nrm), 3))
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(mesh.uv), 2))
  const u = {}
  for (const [k, v] of Object.entries(sh.uniforms)) u[k] = { value: Array.isArray(v) ? (v.length === 2 ? new THREE.Vector2(...v) : new THREE.Vector3(...v)) : v }
  if (inputs) for (const [k, b64] of Object.entries(inputs)) {
    const bin = atob(b64), bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const t = new THREE.DataTexture(new Float32Array(bytes.buffer), size, size, THREE.RGBAFormat, THREE.FloatType)
    t.needsUpdate = true
    u['in_' + k] = { value: t }
  }
  const mat = new THREE.ShaderMaterial({ vertexShader: sh.vertexShader, fragmentShader: sh.fragmentShader, uniforms: u, side: THREE.DoubleSide })
  const m = new THREE.Mesh(g, mat)
  m.matrixAutoUpdate = false
  const Mb = new THREE.Matrix4().set(...mesh.matrix.flat())
  m.matrix.copy(A.clone().multiply(Mb).multiply(A.clone().invert()))
  const scene = new THREE.Scene(); scene.add(m)
  m.frustumCulled = false
  r.setRenderTarget(rt); r.setClearColor(0x000000, 0); r.clear()
  r.render(scene, new THREE.Camera())
  const px = new Float32Array(size * size * 4)
  r.readRenderTargetPixels(rt, 0, 0, size, size, px)
  return Array.from(px)
}
window.picture = (blend, three, size) => {
  const c = document.createElement('canvas'); c.width = size * 3; c.height = size
  const x = c.getContext('2d'); const im = x.createImageData(size * 3, size)
  const enc = (v) => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)))
  for (let yy = 0; yy < size; yy++) for (let xx = 0; xx < size; xx++) {
    const i = ((size - 1 - yy) * size + xx) * 4
    const put = (col, r, g, b) => { const o = (yy * size * 3 + col * size + xx) * 4; im.data[o] = r; im.data[o+1] = g; im.data[o+2] = b; im.data[o+3] = 255 }
    put(0, enc(blend[i]), enc(blend[i+1]), enc(blend[i+2]))
    put(1, enc(three[i]), enc(three[i+1]), enc(three[i+2]))
    const d = Math.max(Math.abs(blend[i]-three[i]), Math.abs(blend[i+1]-three[i+1]), Math.abs(blend[i+2]-three[i+2]))
    const heat = Math.min(255, Math.round(d * 255 * 50)) // 1/255 difference shows as bright
    const on = blend[i+3] > 0.5 && three[i+3] > 0.5
    put(2, on ? heat : 30, on ? (d < 0.5/255 ? 40 : 0) : 30, on ? 0 : 30)
  }
  x.putImageData(im, 0, 0); return c.toDataURL('image/png')
}
window.ready = true
</script>`

const server = http.createServer((req, res) => {
  if (req.url === '/three.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(fs.readFileSync(threeFile)) }
  else { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page) }
}).listen(0)
const port = server.address().port
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const tab = await browser.newPage()
tab.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('  page:', m.text().slice(0, 400)) })
await tab.goto(`http://localhost:${port}/`)
await tab.waitForFunction('window.ready')

const report = []
let failed = false
for (const [name, b] of Object.entries(bake)) {
  const ir = check(graphs[name])
  const sh = toThree(ir, { bakeUV: true })
  if (EXACT) {
    // feed the shader the very numbers Blender used at each texel
    const decl = ['uv', 'object_pos', 'object_normal', 'world_pos', 'normal'].map((k) => `uniform sampler2D in_${k};`).join('\n')
    const at = (k) => `texelFetch(in_${k}, ivec2(gl_FragCoord.xy), 0).xyz`
    sh.fragmentShader = sh.fragmentShader.replace('void main() {', decl + '\nvoid main() {')
      .replace(/vec3 g_uv = .*;/, `vec3 g_uv = ${at('uv')};`).replace(/vec3 g_obj = .*;/, `vec3 g_obj = ${at('object_pos')};`)
      .replace(/vec3 g_onrm = .*;/, `vec3 g_onrm = ${at('object_normal')};`).replace(/vec3 g_wpos = .*;/, `vec3 g_wpos = ${at('world_pos')};`)
      .replace(/vec3 g_nrm = .*;/, `vec3 g_nrm = ${at('normal')};`).replace(/vec3 g_view = .*;/, 'vec3 g_view = g_nrm;')
  }
  const three = await tab.evaluate(([m, s, n, i]) => window.renderBake(m, s, n, i), [b.mesh, sh, b.size, EXACT ? b.inputs : null])
  const blend = Array.from(new Float32Array(Buffer.from(b.pixels, 'base64').buffer.slice(0)))
  let n = 0, same = 0, close = 0, max = 0, sum = 0
  for (let i = 0; i < blend.length; i += 4) {
    if (!(blend[i + 3] > 0.5 && three[i + 3] > 0.5)) continue
    n++
    const d = Math.max(Math.abs(blend[i] - three[i]), Math.abs(blend[i + 1] - three[i + 1]), Math.abs(blend[i + 2] - three[i + 2]))
    max = Math.max(max, d); sum += d
    if (d < 0.5 / 255) same++
    if (d < 2 / 255) close++
  }
  fs.writeFileSync(`${outDir}/three-${name.replace(/\W+/g, '-').toLowerCase()}.raw`, Buffer.from(new Float32Array(three).buffer))
  const png = await tab.evaluate(([a, t, s]) => window.picture(a, t, s), [blend, three, b.size])
  const file = `${outDir}/parity-${name.replace(/\W+/g, '-').toLowerCase()}.png`
  fs.writeFileSync(file, Buffer.from(png.split(',')[1], 'base64'))
  const row = { shader: name, texels: n, identical_8bit: `${(100 * same / n).toFixed(3)}%`, within_2_of_255: `${(100 * close / n).toFixed(3)}%`, mean_diff: (sum / n).toExponential(2), max_diff: max.toExponential(2) }
  report.push(row)
  if (close / n < 0.97) { if (DIFFERS.has(name)) row.note = 'different random pattern, as expected (fract(sin()) noise)'; else failed = true } // pass: 97% of texels within 2/255
  console.log(row)
}
fs.writeFileSync(`${outDir}/parity.json`, JSON.stringify(report, null, 2))
await browser.close(); server.close()
process.exit(failed ? 1 : 0)
