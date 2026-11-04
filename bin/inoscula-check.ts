#!/usr/bin/env node
// Render check: renders one Inoscula shader in the real programs, in the same test scene (a sphere and a box on a
// floor, one sun, a soft sky, the same camera and the same AgX tonemapping), and puts the pictures side by side.
//   node bin/inoscula-check.ts <shader.inoscula|.inoscula.json> [--out folder] [--blender path|bpy] [--godot path] [--engine CYCLES|EEVEE]
// --blender bpy uses Python's bpy module; give a Blender path to use your own Blender (Eevee needs a GPU).
// RICO's render uses Playwright's Chromium; Godot needs Godot 4.4 or later.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { check, toBlender, toGodot, toGodotOutline, toThree } from '../src/index.ts'
import { parse } from '../src/lang.ts'
import { brushCards, paintShells } from '../src/cards.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d }
const out = path.resolve(opt('--out', 'check-out'))
const blender = opt('--blender', 'bpy'), godot = opt('--godot', ''), engine = opt('--engine', 'CYCLES'), three = opt('--three', path.join(here, '..', 'node_modules', 'three', 'build', 'three.module.js'))
const file = args[0]
if (!file) { console.log('usage: inoscula-check <shader.inoscula|.inoscula.json> [--out folder] [--blender path|bpy] [--godot path] [--engine CYCLES|EEVEE]'); process.exit(1) }
const text = fs.readFileSync(file, 'utf8')
const graph = text.trim().startsWith('{') ? JSON.parse(text) : parse(text)
const ir = check(graph)
const base = ir.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
fs.mkdirSync(out, { recursive: true })
const shots: [string, string][] = []

// brush cards for looks made for them: the same cards on the test sphere and box for RICO and Godot (Blender
// lays its own with importers/inoscula_cards_blender.py)
let cardsJson = ''
if (graph.cards || graph.shells) {
  const T = await import(path.resolve(three))
  const pack = (g: any) => { const k = graph.cards ? brushCards(g.attributes.position.array, g.attributes.normal.array, g.index ? g.index.array : null, graph.cards) : paintShells(g.attributes.position.array, g.attributes.normal.array, g.index ? g.index.array : null, graph.shells); return { p: Array.from(k.positions), n: Array.from(k.normals), u: Array.from(k.uvs), i: Array.from(k.indices) } }
  cardsJson = path.join(out, base + '.cards.json')
  fs.writeFileSync(cardsJson, JSON.stringify({ ball: pack(new T.SphereGeometry(1, 96, 48)), box: pack(new T.BoxGeometry(1.5, 1.5, 1.5, 24, 24, 24)) }))
}

// Blender
fs.writeFileSync(path.join(out, base + '.blender.py'), toBlender(ir))
try {
  const png = path.join(out, `${base}-blender.png`)
  const script = path.join(here, '..', 'check', 'render_blender.py')
  if (blender === 'bpy') execFileSync('python3', [script, path.join(out, base + '.blender.py'), png, engine, '48'], { stdio: 'pipe' })
  else execFileSync(blender, ['--background', '--factory-startup', '--python', script, '--', path.join(out, base + '.blender.py'), png, engine, '48'], { stdio: 'pipe' })
  shots.push([`Blender (${engine === 'CYCLES' ? 'Cycles' : 'Eevee'}, AgX)`, png])
} catch (e: any) { console.log('Blender render failed:', String(e.stderr ?? e).slice(-600)) }

// Godot
if (godot) {
  const gd = path.join(out, base + '.gdshader')
  fs.writeFileSync(gd, toGodot(ir, { flipV: false }))
  const gdo = ir.outline ? path.join(out, base + '_outline.gdshader') : ''
  if (gdo) fs.writeFileSync(gdo, toGodotOutline(ir))
  const png = path.join(out, `${base}-godot.png`)
  const proj = path.join(out, 'godot-project')
  fs.mkdirSync(proj, { recursive: true })
  fs.writeFileSync(path.join(proj, 'project.godot'), 'config_version=5\n\n[application]\nconfig/name="inoscula-check"\n')
  fs.copyFileSync(path.join(here, '..', 'check', 'render_godot.gd'), path.join(proj, 'render_godot.gd'))
  try {
    const cmd = process.platform === 'linux' && !process.env.DISPLAY ? ['xvfb-run', ['-a', '-s', '-screen 0 640x480x24', godot]] as const : [godot, []] as const
    execFileSync(cmd[0], [...cmd[1], '--path', proj, '--rendering-method', 'forward_plus', '-s', 'render_godot.gd', '--', gd, png, gdo, cardsJson], { stdio: 'pipe', timeout: 240000 })
    if (fs.existsSync(png)) shots.push(['Godot 4 (Forward+, AgX)', png])
  } catch (e: any) { console.log('Godot render failed:', String(e.stdout ?? e).slice(-600)) }
}

// RICO Engine (three.js), then the side-by-side sheet
const { chromium } = await import('playwright')
const sh = toThree(ir)
const page = `<!doctype html><body style="margin:0;background:#000"><canvas id=c width=640 height=480></canvas>
<script type=importmap>{"imports":{"three":"/three.js"}}</script>
<script type=module>
import * as THREE from 'three'
const sh = ${JSON.stringify({ ...sh, litPatch: undefined })}
const cards = ${cardsJson ? fs.readFileSync(cardsJson, 'utf8') : 'null'}
const lit = ${sh.lit}, coat = ${Boolean(ir.layers.coat)}, sheen = ${Boolean(ir.layers.sheen)}
const B = (x, y, z) => new THREE.Vector3(x, z, -y) // Blender to three
const r = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: true, preserveDrawingBuffer: true })
r.toneMapping = THREE.AgXToneMapping; r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap
const scene = new THREE.Scene(); scene.background = new THREE.Color().setRGB(0.35, 0.42, 0.55)
{ // an even sky, like Blender's world colour: lights and reflects
  // the floor blocks the lower half, as it does in Cycles and Godot: without that, undersides glow
  const s = new THREE.Scene(); s.background = new THREE.Color().setRGB(0.35 * 0.6, 0.42 * 0.6, 0.55 * 0.6)
  const under = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(0.07, 0.07, 0.07), side: THREE.BackSide })); s.add(under)
  scene.environment = new THREE.PMREMGenerator(r).fromScene(s).texture
}
const sun = new THREE.DirectionalLight(0xffffff, 3.5); sun.position.copy(B(-0.5, -0.6, 0.62).normalize().multiplyScalar(8)); sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4 }); sun.shadow.bias = -0.0002; sun.shadow.normalBias = 0.03; sun.shadow.camera.near = 2; sun.shadow.camera.far = 16
scene.add(sun, sun.target)
const u = {}; for (const [k, v] of Object.entries(sh.uniforms)) u[k] = { value: Array.isArray(v) ? new THREE.Vector3(...v) : v }
u.inoscula_light_dir.value.copy(sun.position).normalize()
let mat
if (lit) {
  const edits = sh.litEdits
  const apply = (src, list) => { for (const [f, a] of list) src = src.replace(f, f + '\\n' + a); return src }
  const patch = (vs, fs) => ({ vertexShader: apply(vs, edits.vertex), fragmentShader: apply(fs, edits.fragment) })
  mat = new THREE.MeshPhysicalMaterial({ vertexColors: sh.vertexColors }); mat.defines = { USE_UV: '' }; if (coat) mat.clearcoat = 1; if (sheen) mat.sheen = 1
  mat.onBeforeCompile = (s) => { Object.assign(s.uniforms, u); const p = patch(s.vertexShader, s.fragmentShader); s.vertexShader = p.vertexShader; s.fragmentShader = p.fragmentShader }
} else mat = new THREE.ShaderMaterial({ vertexShader: sh.vertexShader, fragmentShader: sh.fragmentShader, uniforms: u })
if (${ir.cutout}) { mat.side = THREE.DoubleSide; if (lit) mat.alphaTest = 0.5 }
const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), mat); ball.position.copy(B(-1.15, 0, 1.0))
const box = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5, 24, 24, 24), mat); box.position.copy(B(1.15, 0, 0.75)); box.rotation.y = Math.PI / 6
for (const m of [ball, box]) { m.castShadow = m.receiveShadow = true; scene.add(m) }
// object_size, as Blender's dimensions and Godot's bounds give it
if (u.inoscula_object_size) for (const [m, sz] of [[ball, 2 * Math.sqrt(3)], [box, 1.5 * Math.sqrt(3)]]) m.onBeforeRender = () => { u.inoscula_object_size.value = sz; mat.uniformsNeedUpdate = true }
if (cards) for (const [m, k] of [[ball, cards.ball], [box, cards.box]]) {
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(k.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(k.n, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(k.u, 2)); g.setIndex(k.i)
  const c = new THREE.Mesh(g, mat); c.castShadow = true; m.add(c)
}
if (sh.outline) {
  const ou = {}; for (const [k, from] of Object.entries(sh.outline.uniforms)) ou[k] = u[from]
  const om = new THREE.ShaderMaterial({ vertexShader: sh.outline.vertexShader, fragmentShader: sh.outline.fragmentShader, uniforms: ou, side: THREE.BackSide })
  for (const m of [ball, box]) m.add(new THREE.Mesh(m.geometry, om))
}
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.32, 0.32, 0.32), roughness: 0.9 })); floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor)
{ // contact shade: the soft darkening where an object meets the floor, which Cycles and Godot get from bounce light
  const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d'), gr = x.createRadialGradient(64, 64, 0, 64, 64, 64)
  gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(0.3, 'rgba(0,0,0,0.6)'); gr.addColorStop(0.6, 'rgba(0,0,0,0.2)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = gr; x.fillRect(0, 0, 128, 128)
  const tex = new THREE.CanvasTexture(c)
  for (const [m, w] of [[ball, 1.5], [box, 2.4]]) { const b = new THREE.Mesh(new THREE.PlaneGeometry(w, w), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.75, toneMapped: false })); b.rotation.x = -Math.PI / 2; b.position.set(m.position.x, 0.002, m.position.z); b.renderOrder = 1; scene.add(b) }
}
const cam = new THREE.PerspectiveCamera(2 * Math.atan(Math.tan(Math.atan(18 / 50)) / (4 / 3)) * 180 / Math.PI, 4 / 3, 0.1, 100)
cam.position.copy(B(0, -6.2, 1.6)); cam.lookAt(B(0, 0, 0.9))
r.render(scene, cam)
window.shot = document.getElementById('c').toDataURL('image/png')
window.sheet = async (items) => {
  const imgs = await Promise.all(items.map(([l, d]) => new Promise((res) => { const i = new Image(); i.onload = () => res([l, i]); i.src = d })))
  const c = document.createElement('canvas'); c.width = 640 * imgs.length + 16 * (imgs.length + 1); c.height = 480 + 60
  const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height)
  imgs.forEach(([l, i], k) => { const ox = 16 + k * 656; x.drawImage(i, ox, 44, 640, 480); x.fillStyle = '#3bff03'; x.font = '20px monospace'; x.fillText(l, ox, 30) })
  return c.toDataURL('image/png')
}
</script>`
const server = http.createServer((req, res) => {
  if (req.url === '/three.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(fs.readFileSync(three)) }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(page)
}).listen(0)
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const tab = await browser.newPage({ viewport: { width: 640, height: 480 } })
tab.on('pageerror', (e) => console.log('RICO render error:', e.message))
await tab.goto(`http://localhost:${(server.address() as any).port}/`, { waitUntil: 'commit', timeout: 120000 })
await tab.waitForFunction('window.shot', null, { timeout: 900000 })
const ricoPng = path.join(out, `${base}-rico.png`)
fs.writeFileSync(ricoPng, Buffer.from(((await tab.evaluate('window.shot')) as string).split(',')[1], 'base64'))
shots.unshift(['RICO Engine (AgX)', ricoPng])
const items = shots.map(([l, p]) => [l, 'data:image/png;base64,' + fs.readFileSync(p).toString('base64')])
const sheetUrl = await tab.evaluate((it) => (window as any).sheet(it), items)
const sheet = path.join(out, `${base}-check.png`)
fs.writeFileSync(sheet, Buffer.from((sheetUrl as string).split(',')[1], 'base64'))
await browser.close(); server.close()
console.log(`Inoscula: ${shots.length} renders side by side in ${sheet}`)
