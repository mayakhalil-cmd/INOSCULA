// A still life for painterly looks: a head on a round plinth with two spheres in front, a warm key light from
// the right, a dark backdrop. Renders one look at 900 x 900, through the RICO adapter.
//   node test/refscene.mjs <three.module.js> <model.glb> <out.png> <look.inoscula> [seconds]
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import { chromium } from 'playwright'
const [threeFile, model, outPng, file, secs = '1'] = process.argv.slice(2)
const jsm = path.join(path.dirname(threeFile), '..', 'examples', 'jsm')
const code = fs.readFileSync(file, 'utf8')
const page = `<!doctype html><body style="margin:0;background:#000"><canvas id=c width=900 height=900></canvas>
<script type=importmap>{"imports":{"three":"/three.js","three/addons/":"/jsm/"}}</script>
<script type=module>
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { inosculaMaterial } from '/src/rico.ts'
import { parse } from '/src/lang.ts'
const r = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: true, preserveDrawingBuffer: true })
r.toneMapping = ${process.env.TONE === 'neutral' ? 'THREE.NeutralToneMapping' : 'THREE.AgXToneMapping'}
const scene = new THREE.Scene(); scene.background = new THREE.Color(0.2, 0.11, 0.17)
if (${process.env.ENV ? 'true' : 'false'}) {
  const room = new THREE.Scene(); room.background = new THREE.Color(0.02, 0.06, 0.06)
  for (const [w, h, x, y, z, col, k] of [[16, 10, 0, 3, -12, [0.05, 0.45, 0.4], 1.2], [6, 14, 10, 4, -2, [1.0, 0.25, 0.1], 3], [8, 6, -10, 3, 3, [0.95, 0.3, 0.6], 2.5], [20, 4, 0, -4, 6, [1.0, 0.85, 0.6], 1.6], [4, 4, 3, 10, 2, [1, 1, 1], 4]]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(col[0] * k, col[1] * k, col[2] * k), side: THREE.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); room.add(m)
  }
  scene.environment = new THREE.PMREMGenerator(r).fromScene(room, 0.02).texture
}
const sun = new THREE.DirectionalLight(new THREE.Color('#' + (${JSON.stringify(process.env.LIGHTCOL ?? 'ffffff')})), 2.5); sun.position.set(...(${process.env.LIGHT ?? "[-4, 3.5, -2.5]"})); scene.add(sun, sun.target)
const PALETTE = ${process.env.PALETTE ?? '{}'}
const graph = parse(${JSON.stringify(code)})
const objs = []
const head = (await new GLTFLoader().loadAsync('/model.glb')).scene
head.traverse((o) => { if (o.isMesh) o.geometry.computeVertexNormals() })
head.scale.setScalar(1.05); head.position.set(0, 0.55, 0); head.rotation.set(-0.8, 0, 0)
const disk = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 0.12, 160, 1)); disk.position.set(0, -0.35, 0)
const s1 = new THREE.Mesh(new THREE.SphereGeometry(0.42, 96, 48)); s1.position.set(-1.6, -1.0, 2.1)
const s2 = new THREE.Mesh(new THREE.SphereGeometry(0.42, 96, 48)); s2.position.set(-0.55, -1.0, 2.2)
// a painted backdrop: the inside of a big bowl facing the camera, so its strokes swirl around the scene
const dg = new THREE.SphereGeometry(9, 96, 48, 0, Math.PI * 2, 0, Math.PI * 0.55)
{ const n = dg.attributes.normal; for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i)); const ix = dg.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t } }
dg.rotateX(-Math.PI / 2); const dome = new THREE.Mesh(dg); dome.position.set(0, 0, 2)
const looks = []
for (const o of [head, ...(${process.env.NOPLINTH ? 'true' : 'false'} ? [] : [disk]), s1, s2, ...(${process.env.BACKDROP ? 'true' : 'false'} ? [dome] : [])]) {
  const look = inosculaMaterial(THREE, graph); if (!look.material.isMeshPhysicalMaterial) look.material.toneMapped = false
  o.traverse((m) => { if (m.isMesh) m.material = look.material })
  scene.add(o); o.updateMatrixWorld(true)
  if (graph.cards && o !== dome) look.addCards(o)
  if (graph.shells && o !== dome) look.addShells(o)
  for (const [k, v] of Object.entries(PALETTE)) look.set(k, v)
  if (o === dome) { look.set('strokeSize', 0.45); look.set('strokeLength', 4.0); look.set('relief', 0.3); look.set('keyPoint', 1.0); look.set('keyPos', [0.0, 3.0, 9.0]); look.set('falloff', 0.35); look.set('ambient', 0.04); look.set('fillStrength', 0.2); look.set('variety', 0.25); look.set('strokeSize', 2.4); look.set('edgeBreak', 0); look.set('lineWidth', 0) }
  if (o === dome) for (const [k, v] of Object.entries(${process.env.DOMESET ?? '{}'})) look.set(k, v)
  look.fitTo(o); look.addOutline(o); looks.push(look)
}
const cam = new THREE.PerspectiveCamera(32, 1, 0.1, 60); cam.position.set(0, 4.4, 7.6); cam.lookAt(0, -0.3, 0.3)
for (const l of looks) l.tick(${+secs}, sun)
r.render(scene, cam)
window.done = document.getElementById('c').toDataURL('image/png')
</script>`
const server = http.createServer((req, res) => {
  const js = (b) => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(b) }
  if (req.url === '/three.js') return js(fs.readFileSync(threeFile))
  if (req.url === '/model.glb') { res.writeHead(200, { 'content-type': 'model/gltf-binary' }); return res.end(fs.readFileSync(model)) }
  if (req.url.startsWith('/jsm/')) return js(fs.readFileSync(path.join(jsm, req.url.slice(5))))
  if (req.url.startsWith('/src/')) return js(stripTypeScriptTypes(fs.readFileSync('.' + req.url, 'utf8')))
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(page)
}).listen(0)
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const tab = await browser.newPage({ viewport: { width: 1000, height: 1000 } })
tab.on('pageerror', (e) => { console.log('page exception:', e.message); process.exit(1) })
tab.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('console:', m.text().slice(0, 1500)) })
await tab.goto(`http://localhost:${server.address().port}/`)
await tab.waitForFunction('window.done', null, { timeout: 400000 })
fs.writeFileSync(outPng, Buffer.from((await tab.evaluate('window.done')).split(',')[1], 'base64'))
await browser.close(); server.close()
console.log('wrote', outPng)
