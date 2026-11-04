// Contact sheet of the look library, rendered live through the RICO Engine adapter.
//   node test/looks_preview.mjs <three.module.js> <out.png> [seconds]
import fs from 'node:fs'
import http from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import { chromium } from 'playwright'

const [threeFile, outPng, secs = '1.0'] = process.argv.slice(2)
const looks = fs.readdirSync('looks').sort().map((f) => fs.readFileSync('looks/' + f, 'utf8'))
const page = `<!doctype html><body style="margin:0;background:#000"><canvas id=c width=1600 height=820></canvas>
<script type=importmap>{"imports":{"three":"/three.js"}}</script>
<script type=module>
import * as THREE from 'three'
import { inosculaMaterial } from '/src/rico.ts'
import { parse } from '/src/lang.ts'
const src = ${JSON.stringify(looks)}
const r = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: true })
r.setClearColor(0x000000)
const scene = new THREE.Scene()
const cam = new THREE.OrthographicCamera(-8, 8, 4.1, -4.1, 0.1, 100); cam.position.set(0, 0, 20)
const sun = new THREE.DirectionalLight(0xffffff, 1); sun.position.set(-3, 4, 5); scene.add(sun, sun.target)
const geos = [new THREE.SphereGeometry(1.45, 128, 64), new THREE.TorusKnotGeometry(0.95, 0.38, 256, 48)]
src.forEach((s, i) => {
  const look = inosculaMaterial(THREE, parse(s))
  const m = new THREE.Mesh(geos[i % 2], look.material)
  m.position.set(-6 + (i % 4) * 4, 2 - Math.floor(i / 4) * 4.1, 0); m.rotation.set(0.35, 0.6, 0)
  look.tick(${secs}, sun); scene.add(m)
})
r.render(scene, cam)
window.done = 'ok'
</script>`
const server = http.createServer((req, res) => {
  if (req.url === '/three.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(fs.readFileSync(threeFile)) }
  if (req.url.startsWith('/src/')) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(stripTypeScriptTypes(fs.readFileSync('.' + req.url, 'utf8'))) }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(page)
}).listen(0)
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const tab = await browser.newPage({ viewport: { width: 1600, height: 820 } })
tab.on('console', (m) => { if (m.type() === 'error') console.log('page error:', m.text().slice(0, 800)) })
tab.on('pageerror', (e) => console.log('page exception:', e.message))
await tab.goto(`http://localhost:${server.address().port}/`)
await tab.waitForFunction('window.done', null, { timeout: 180000 })
await tab.locator('canvas').screenshot({ path: outPng })
console.log(fs.readdirSync('looks').sort().join(' | '))
await browser.close(); server.close()
