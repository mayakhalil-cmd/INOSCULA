// The whole look library on one sheet, rendered through the RICO Engine adapter with a studio light, AgX and
// soft shadows, each look on the shape the Studio uses for it.
//   node test/library_sheet.mjs <three.module.js> <out.png> [seconds]
import fs from 'node:fs'
import http from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import { chromium } from 'playwright'

const [threeFile, outPng, secs = '1.3'] = process.argv.slice(2)
const order = [['oil-paint', 'Sphere'], ['wet-stroke', 'Puppet'], ['hand-painted', 'Puppet'], ['oil-strokes', 'Puppet'], ['paint-strokes', 'Puppet'], ['painted-planes', 'Knot'], ['paint-with-light', 'Puppet'], ['painted-character', 'Puppet'], ['paint-bands', 'Knot'], ['hard-reflections', 'Knot'], ['comic-print', 'Knot'], ['mono-ink', 'Puppet'], ['ink-city', 'Box'],
  ['engraving', 'Knot'], ['grain-gradient', 'Puppet'], ['iridescent', 'Knot'], ['claymation', 'Puppet']]
const looks = order.map(([n, shape]) => ({ code: fs.readFileSync(`looks/${n}.inoscula`, 'utf8'), shape }))
const COLS = 6, CW = 360, CH = 380
const W = COLS * CW, H = Math.ceil(looks.length / COLS) * CH
const page = `<!doctype html><body style="margin:0;background:#000"><canvas id=c width=${W} height=${H}></canvas>
<script type=importmap>{"imports":{"three":"/three.js"}}</script>
<script type=module>
import * as THREE from 'three'
import { inosculaMaterial } from '/src/rico.ts'
import { parse } from '/src/lang.ts'
const looks = ${JSON.stringify(looks)}
const r = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: true, preserveDrawingBuffer: true })
r.toneMapping = THREE.AgXToneMapping; r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap; r.setScissorTest(true)
// studio light: a dim room with three soft panels, for reflections and fill
const room = new THREE.Scene(); room.background = new THREE.Color(0.03, 0.03, 0.035)
for (const [w, h, x, y, z, k] of [[14, 8, -14, 10, 12, 6], [10, 10, 16, 6, 6, 3.5], [20, 4, 0, 14, -18, 4]]) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k, k), side: THREE.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); room.add(m)
}
const env = new THREE.PMREMGenerator(r).fromScene(room, 0.03).texture
function puppet() {
  const g = new THREE.Group()
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.62, 0.7, 24, 64)); body.position.y = -0.55
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.7, 96, 48)); head.position.y = 0.75
  const e1 = new THREE.Mesh(new THREE.SphereGeometry(0.22, 48, 24)); e1.position.set(-0.55, 1.25, 0); const e2 = e1.clone(); e2.position.x = 0.55
  g.add(body, head, e1, e2); g.scale.setScalar(0.85); return g
}
function box() {
  const g = new THREE.BoxGeometry(1.8, 1.8, 1.8, 24, 24, 24), p = g.attributes.position, v = new THREE.Vector3(), rr = 0.18
  for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); const c = v.clone().clampScalar(-0.9 + rr, 0.9 - rr); v.sub(c).normalize().multiplyScalar(rr).add(c); p.setXYZ(i, v.x, v.y, v.z) }
  g.computeVertexNormals(); return new THREE.Mesh(g)
}
const SHAPES = { Sphere: () => new THREE.Mesh(new THREE.SphereGeometry(1.3, 160, 80)), Knot: () => new THREE.Mesh(new THREE.TorusKnotGeometry(0.88, 0.35, 320, 56)), Puppet: puppet, Box: box }
// curvature and occlusion for shapes whose looks read them: a quick per vertex estimate from the normals
function shapeData(obj) {
  obj.traverse((o) => {
    if (!o.isMesh) return
    const g = o.geometry, n = g.attributes.position.count, c = new Float32Array(n * 3)
    const pos = g.attributes.position, nr = g.attributes.normal
    for (let i = 0; i < n; i++) {
      const y = pos.getY(i), up = nr.getY(i)
      // box: sharp where the bevel turns; everything: a little enclosed underneath
      const edge = Math.max(Math.abs(pos.getX(i)), Math.abs(pos.getY(i)), Math.abs(pos.getZ(i))) > 0.83 && Math.abs(Math.abs(nr.getX(i)) + Math.abs(nr.getY(i)) + Math.abs(nr.getZ(i)) - 1) > 0.25
      c[i * 3] = edge ? 0.95 : 0.5; c[i * 3 + 1] = 0.75 + 0.25 * Math.max(0, up); c[i * 3 + 2] = 0.5
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3))
  })
}
for (const [i, l] of looks.entries()) {
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0.02, 0.02, 0.025); scene.environment = env
  const sun = new THREE.DirectionalLight(0xffffff, 2.4); sun.position.set(-3.5, 5, 4.5); sun.castShadow = true
  sun.shadow.mapSize.set(1024, 1024); Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3 }); sun.shadow.bias = -0.0005
  scene.add(sun, sun.target)
  const look = inosculaMaterial(THREE, parse(l.code))
  if (!look.material.isMeshPhysicalMaterial) look.material.toneMapped = false // stylised colours show as written, as RICO shows them
  const obj = SHAPES[l.shape](); obj.rotation.set(0.25, 0.55, 0)
  if (look.material.isMeshPhysicalMaterial) shapeData(obj)
  obj.traverse((o) => { if (o.isMesh) { o.material = look.material; o.castShadow = o.receiveShadow = true } })
  if (parse(l.code).cards) look.addCards(obj)
  if (parse(l.code).shells) look.addShells(obj)
  look.fitTo(obj); look.addOutline(obj)
  scene.add(obj)
  const bb = new THREE.Box3().setFromObject(obj)
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.ShadowMaterial({ opacity: 0.5 })); floor.rotation.x = -Math.PI / 2; floor.position.y = bb.min.y; floor.receiveShadow = true; scene.add(floor)
  look.tick(${secs}, sun)
  const cam = new THREE.PerspectiveCamera(30, ${CW} / ${CH}, 0.1, 50); cam.position.set(0, 0.5, 7.6); cam.lookAt(0, 0.25, 0)
  const x = (i % ${COLS}) * ${CW}, y = ${H} - (Math.floor(i / ${COLS}) + 1) * ${CH}
  r.setViewport(x, y, ${CW}, ${CH}); r.setScissor(x, y, ${CW}, ${CH}); r.render(scene, cam)
}
// labels
const out = document.createElement('canvas'); out.width = ${W}; out.height = ${H}
const g = out.getContext('2d'); g.drawImage(document.getElementById('c'), 0, 0)
g.font = '22px monospace'
looks.forEach((l, i) => {
  const x = (i % ${COLS}) * ${CW}, y = Math.floor(i / ${COLS}) * ${CH}
  g.fillStyle = '#000'; g.fillRect(x, y, ${CW}, 44)
  g.fillStyle = '#3bff03'; g.fillText(/name "([^"]+)"/.exec(l.code)[1].toUpperCase(), x + 16, y + 30)
})
g.strokeStyle = '#1a4a08'; g.lineWidth = 2
for (let i = 0; i < looks.length; i++) g.strokeRect((i % ${COLS}) * ${CW} + 1, Math.floor(i / ${COLS}) * ${CH} + 1, ${CW} - 2, ${CH} - 2)
window.done = out.toDataURL('image/png')
</script>`
const server = http.createServer((req, res) => {
  if (req.url === '/three.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(fs.readFileSync(threeFile)) }
  if (req.url.startsWith('/src/')) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(stripTypeScriptTypes(fs.readFileSync('.' + req.url, 'utf8'))) }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(page)
}).listen(0)
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const tab = await browser.newPage({ viewport: { width: 1200, height: 800 } })
tab.on('pageerror', (e) => console.log('page exception:', e.message))
tab.on('console', (m) => { if (m.type() === 'error') console.log('page error:', m.text().slice(0, 400)) })
await tab.goto(`http://localhost:${server.address().port}/`, { waitUntil: 'commit', timeout: 600000 })
await tab.waitForFunction('window.done', null, { timeout: 3000000 })
fs.writeFileSync(outPng, Buffer.from((await tab.evaluate('window.done')).split(',')[1], 'base64'))
console.log('wrote', outPng)
await browser.close(); server.close()
