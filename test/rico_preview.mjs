// Checks the RICO Engine adapter end to end with RICO's own three.js: every example becomes a live material on
// a sphere, driven by a real DirectionalLight through the lighting contract, then saved as a picture.
//   node test/rico_preview.mjs <three.module.js> <out.png>
import fs from 'node:fs'
import http from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import { chromium } from 'playwright'

const [threeFile, outPng] = process.argv.slice(2)
const examples = fs.readdirSync('examples').sort().map((f) => JSON.parse(fs.readFileSync('examples/' + f, 'utf8')))
const page = `<!doctype html><body style="margin:0;background:#000"><canvas id=c width=1600 height=400></canvas>
<script type=importmap>{"imports":{"three":"/three.js"}}</script>
<script type=module>
import * as THREE from 'three'
import { inosculaMaterial } from '/src/rico.ts'
const graphs = ${JSON.stringify(examples)}
const r = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: true })
r.setClearColor(0x0b0b0b)
const scene = new THREE.Scene()
const cam = new THREE.PerspectiveCamera(30, 4, 0.1, 100); cam.position.set(0, 0, 8.2)
const sun = new THREE.DirectionalLight(0xffffff, 1); sun.position.set(3, 4, 5); scene.add(sun, sun.target)
const looks = graphs.map((g, i) => {
  const look = inosculaMaterial(THREE, g)
  const m = new THREE.Mesh(new THREE.SphereGeometry(1.2, 96, 48), look.material)
  m.position.x = (i - (graphs.length - 1) / 2) * 3.1; m.rotation.set(0.3, 0.5, 0)
  scene.add(m); return look
})
looks.forEach((l) => l.tick(1.0, sun))
looks[0].set(looks[0].params[0].id, looks[0].params[0].default) // parameters can be driven live
r.render(scene, cam)
window.done = r.getContext().getError() === 0 ? 'ok' : 'gl error'
</script>`
const server = http.createServer((req, res) => {
  if (req.url === '/three.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(fs.readFileSync(threeFile)) }
  if (req.url.startsWith('/src/')) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(stripTypeScriptTypes(fs.readFileSync('.' + req.url, 'utf8'))) }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(page)
}).listen(0)
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const tab = await browser.newPage({ viewport: { width: 1600, height: 400 } })
tab.on('console', (m) => { if (m.type() === 'error') console.log('page error:', m.text().slice(0, 500)) })
tab.on('pageerror', (e) => console.log('page exception:', e.message))
await tab.goto(`http://localhost:${server.address().port}/`)
await tab.waitForFunction('window.done', null, { timeout: 120000 })
console.log('RICO adapter:', await tab.evaluate('window.done'))
await tab.locator('canvas').screenshot({ path: outPng })
await browser.close(); server.close()
