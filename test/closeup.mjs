// A close look at one or more looks: a big render on a character head, a sphere and a knot.
//   node test/closeup.mjs <three.module.js> <model.glb> <out.png> <look.inoscula> [more.inoscula ...]
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import { chromium } from 'playwright'
const [threeFile, model, outPng, ...files] = process.argv.slice(2)
const jsm = path.join(path.dirname(threeFile), '..', 'examples', 'jsm')
const looks = files.map((f) => fs.readFileSync(f, 'utf8'))
const W = 1500, H = 560 * looks.length
const page = `<!doctype html><body style="margin:0;background:#000"><canvas id=c width=${W} height=${H}></canvas>
<script type=importmap>{"imports":{"three":"/three.js","three/addons/":"/jsm/"}}</script>
<script type=module>
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { inosculaMaterial } from '/src/rico.ts'
import { parse } from '/src/lang.ts'
const looks = ${JSON.stringify(looks)}
const r = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: true, preserveDrawingBuffer: true })
r.toneMapping = THREE.AgXToneMapping; r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap; r.setScissorTest(true)
const room = new THREE.Scene(); room.background = new THREE.Color(0.03, 0.03, 0.035)
for (const [w, h, x, y, z, k] of [[14, 8, -14, 10, 12, 6], [10, 10, 16, 6, 6, 3.5], [20, 4, 0, 14, -18, 4]]) { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k, k), side: THREE.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); room.add(m) }
const env = new THREE.PMREMGenerator(r).fromScene(room, 0.03).texture
const head = (await new GLTFLoader().loadAsync('/model.glb')).scene
head.traverse((o) => { if (o.isMesh) o.geometry.computeVertexNormals() })
const shapes = [() => head.clone(true), () => new THREE.Mesh(new THREE.SphereGeometry(1.15, 160, 80)), () => new THREE.Mesh(new THREE.TorusKnotGeometry(0.8, 0.32, 320, 56))]
looks.forEach((code, li) => {
  shapes.forEach((mk, si) => {
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0.11, 0.1, 0.12); scene.environment = env
    const sun = new THREE.DirectionalLight(0xffffff, 2.6); sun.position.set(-4.5, 3.5, 1.5); sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3 }); sun.shadow.bias = -0.0005
    scene.add(sun, sun.target)
    const look = inosculaMaterial(THREE, parse(code))
    if (!look.material.isMeshPhysicalMaterial) look.material.toneMapped = false
    const obj = mk(); obj.rotation.set(si === 0 ? 0 : 0.3, si === 0 ? 0.35 : 0.5, 0)
    obj.traverse((o) => { if (o.isMesh) { o.material = look.material; o.castShadow = o.receiveShadow = true } })
    const parsed = parse(code); if (parsed.cards) look.addCards(obj)
    look.fitTo(obj); look.addOutline(obj)
    scene.add(obj)
    const bb = new THREE.Box3().setFromObject(obj)
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.ShadowMaterial({ opacity: 0.45 })); floor.rotation.x = -Math.PI / 2; floor.position.y = bb.min.y; floor.receiveShadow = true; scene.add(floor)
    look.tick(1.0, sun)
    const cam = new THREE.PerspectiveCamera(28, 500 / 560, 0.1, 50); cam.position.set(0, 0.35, 6.2); cam.lookAt(0, 0, 0)
    const x = si * 500, y = ${H} - (li + 1) * 560
    r.setViewport(x, y, 500, 560); r.setScissor(x, y, 500, 560); r.render(scene, cam)
  })
})
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
const tab = await browser.newPage({ viewport: { width: 1200, height: 800 } })
tab.on('pageerror', (e) => console.log('page exception:', e.message))
tab.on('console', (m) => { if (m.type() === 'error') console.log('page error:', m.text().slice(0, 600)) })
await tab.goto(`http://localhost:${server.address().port}/`)
await tab.waitForFunction('window.done', null, { timeout: 400000 })
fs.writeFileSync(outPng, Buffer.from((await tab.evaluate('window.done')).split(',')[1], 'base64'))
console.log('wrote', outPng)
await browser.close(); server.close()
