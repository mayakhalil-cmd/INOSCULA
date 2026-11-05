// A still life for reflective painterly looks: glossy spheres, a box and cylinders in a room lit by teal,
// orange and pink panels, with one key light whose color you choose. Renders one look at 1000 x 750.
//   node test/oilscene.mjs <three.module.js> <out.png> <look.inoscula> [light hex] [seconds]
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import { chromium } from 'playwright'
const [threeFile, outPng, file, hex = 'ffffff', secs = '1'] = process.argv.slice(2)
const code = fs.readFileSync(file, 'utf8')
const page = `<!doctype html><body style="margin:0;background:#000"><canvas id=c width=1000 height=750></canvas>
<script type=importmap>{"imports":{"three":"/three.js","three/addons/":"/jsm/"}}</script>
<script type=module>
import * as THREE from 'three'
import { inosculaMaterial } from '/src/rico.ts'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { parse } from '/src/lang.ts'
const r = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: true, preserveDrawingBuffer: true })
r.toneMapping = ${process.env.TONE === 'neutral' ? 'THREE.NeutralToneMapping' : 'THREE.AgXToneMapping'}; r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap
const room = new THREE.Scene(); room.background = new THREE.Color(0.02, 0.06, 0.06)
for (const [w, h, x, y, z, col, k] of [[16, 10, 0, 3, -12, [0.05, 0.45, 0.4], 1.2], [6, 14, 10, 4, -2, [1.0, 0.25, 0.1], 3], [8, 6, -10, 3, 3, [0.95, 0.3, 0.6], 2.5], [20, 4, 0, -4, 6, [1.0, 0.85, 0.6], 1.6], [4, 4, 3, 10, 2, [1, 1, 1], 4]]) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(col[0] * k, col[1] * k, col[2] * k), side: THREE.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); room.add(m)
}
const env = new THREE.PMREMGenerator(r).fromScene(room, 0.02).texture
const scene = new THREE.Scene(); scene.background = new THREE.Color(${process.env.BG ?? '0.03, 0.22, 0.2'}); scene.environment = env
const sun = new THREE.DirectionalLight(new THREE.Color('#${hex}'), 3); sun.position.set(${process.env.LIGHTPOS ?? '4, 5, 4'}); scene.environmentIntensity = ${process.env.ENVI ?? '1'}; sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5 }); sun.shadow.bias = -0.0005
scene.add(sun, sun.target)
const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: new THREE.Color(${process.env.FLOOR ?? '0.9, 0.55, 0.5'}), roughness: 0.6 })); floor.rotation.x = -Math.PI / 2; floor.position.y = -1; floor.receiveShadow = true; scene.add(floor)
const objs = ${process.env.SHAPES === 'mixed' ? `[
  ['monkey', [-0.2, 0.55, -0.6], [-0.35, 0.25, 0]],
  [new THREE.TorusKnotGeometry(0.55, 0.2, 320, 48), [2.1, 0.35, -0.6], [0.4, 0.3, 0]],
  [new THREE.SphereGeometry(0.62, 128, 64), [-2.3, -0.38, 0.6], [0, 0, 0]],
  [new THREE.BoxGeometry(1.1, 1.1, 1.1, 32, 32, 32), [1.0, -0.42, 1.3], [0.3, 0.7, 0.2]],
  [new THREE.CylinderGeometry(0.4, 0.4, 1.1, 96, 8), [-1.0, -0.55, 1.6], [0.2, 0.3, 1.45]],
  [new THREE.TorusGeometry(0.42, 0.16, 64, 128), [2.6, -0.6, 1.2], [1.2, 0.2, 0.3]],
]
const unusedObjs = [` : '['}
  [new THREE.SphereGeometry(0.85, 128, 64), [-1.2, 0.6, -0.6], [0, 0, 0]],
  [new THREE.SphereGeometry(0.85, 128, 64), [0.8, 0.7, -1.0], [0, 0, 0]],
  [new THREE.SphereGeometry(0.8, 128, 64), [-0.1, -0.2, 1.0], [0, 0, 0]],
  [new THREE.BoxGeometry(1.6, 1.6, 1.6, 32, 32, 32), [-2.6, -0.2, 1.2], [0.3, 0.6, 0.2]],
  [new THREE.CylinderGeometry(0.5, 0.5, 1.4, 96, 8), [2.0, -0.5, 0.9], [0.2, 0.3, 1.45]],
]
const monkey = (await new GLTFLoader().loadAsync('/model.glb')).scene
monkey.traverse((o) => { if (o.isMesh) o.geometry.computeVertexNormals() })
const graph = parse(${JSON.stringify(code)})
const looks = []
const SETP = ${process.env.SET ?? '{}'}
for (const [g, p, rot] of objs) {
  const look = inosculaMaterial(THREE, graph); for (const [k, v] of Object.entries(SETP)) look.set(k, v); if (!look.material.isMeshPhysicalMaterial) look.material.toneMapped = false
  let m
  if (g === 'monkey') { m = monkey.clone(true); m.scale.setScalar(0.95); m.traverse((o) => { if (o.isMesh) { o.material = look.material; o.castShadow = o.receiveShadow = true } }) }
  else m = new THREE.Mesh(g, look.material)
  m.position.set(...p); m.rotation.set(...rot); m.castShadow = m.receiveShadow = true
  scene.add(m); m.updateMatrixWorld(true); if (graph.shells) look.addShells(m); if (graph.cards) look.addCards(m); look.fitTo(m); look.addOutline(m); looks.push(look)
}
// a plain backdrop wall behind the objects (SOLIDBG), same color as the floor, catching shadows
if (${process.env.SOLIDBG ? 'true' : 'false'}) {
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(30, 14), new THREE.MeshStandardMaterial({ color: new THREE.Color(${process.env.FLOOR ?? '0.1, 0.1, 0.1'}), roughness: 0.9 }))
  wall.position.set(0, 5.5, -4); wall.receiveShadow = true; scene.add(wall)
}
// painted floor and wall (PAINTBG): the same look, with its own colors (SETBG)
if (${process.env.PAINTBG ? 'true' : 'false'}) {
  floor.visible = false
  const SETBG = ${process.env.SETBG ?? '{}'}
  const fl = new THREE.Mesh(new THREE.PlaneGeometry(30, 30, 8, 8)); fl.rotation.x = -Math.PI / 2; fl.position.y = -1.02
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(30, 14, 8, 8)); wall.position.set(0, 5.5, -4)
  for (const m of [fl, wall]) {
    const look = inosculaMaterial(THREE, graph); for (const [k, v] of Object.entries(SETP)) look.set(k, v); for (const [k, v] of Object.entries(SETBG)) look.set(k, v)
    if (!look.material.isMeshPhysicalMaterial) look.material.toneMapped = false
    m.material = look.material; m.receiveShadow = true; scene.add(m); m.updateMatrixWorld(true); look.fitTo(m); looks.push(look)
  }
}
const cam = new THREE.PerspectiveCamera(38, 4 / 3, 0.1, 80); cam.position.set(0.3, 1.8, 7.4); cam.lookAt(0, -0.05, 0)
for (const l of looks) l.tick(${+secs}, sun)
r.render(scene, cam)
window.done = document.getElementById('c').toDataURL('image/png')
</script>`
if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, page)
const server = http.createServer((req, res) => {
  const js = (b) => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(b) }
  if (req.url === '/three.js') return js(fs.readFileSync(threeFile))
  if (req.url === '/model.glb') { res.writeHead(200, { 'content-type': 'model/gltf-binary' }); return res.end(fs.readFileSync(process.env.MODEL ?? '../monkey.glb')) }
  if (req.url.startsWith('/jsm/')) return js(fs.readFileSync(path.join(path.dirname(threeFile), '..', 'examples', 'jsm', req.url.slice(5))))
  if (req.url.startsWith('/src/')) return js(stripTypeScriptTypes(fs.readFileSync('.' + req.url, 'utf8')))
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(page)
}).listen(0)
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const tab = await browser.newPage({ viewport: { width: 1100, height: 850 } })
tab.on('pageerror', (e) => { console.log('page exception:', e.message, e.stack); process.exit(1) })
tab.on('request', (q) => { if (process.env.REQS) console.log('req', q.url()) })
await tab.goto(`http://localhost:${server.address().port}/`, { waitUntil: 'commit', timeout: 120000 })
await tab.waitForFunction('window.done', null, { timeout: 400000 })
fs.writeFileSync(outPng, Buffer.from((await tab.evaluate('window.done')).split(',')[1], 'base64'))
await browser.close(); server.close()
console.log('wrote', outPng)
