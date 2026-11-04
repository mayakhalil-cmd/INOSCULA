// Drives Inoscula Studio in a real browser: every look compiles, every export tab builds, the node view draws,
// the preview profiles switch, a model loads and gets its shape data, and errors point at the right line.
//   node test/studio_check.mjs <inoscula-studio.html> <out-dir> [model.glb]
import { chromium } from 'playwright'
const [file, out, model] = process.argv.slice(2)
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const tab = await browser.newPage({ viewport: { width: 1100, height: 800 } })
let errors = 0
tab.on('console', (m) => { if (m.type() === 'error') { errors++; console.log('console error:', m.text().slice(0, 400)) } })
tab.on('pageerror', (e) => { errors++; console.log('exception:', e.message) })
await tab.goto('file://' + file)
await tab.waitForFunction('window.__ready', null, { timeout: 900000 })
const n = await tab.locator('#look option').count()
for (let i = 0; i < n; i++) {
  await tab.selectOption('#look', String(i), { timeout: 900000 })
  await tab.waitForTimeout(350)
  await tab.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 600000 })
  const st = (await tab.locator('#status').textContent({ timeout: 900000 })).slice(0, 120)
  console.log((await tab.locator('#look option').nth(i).textContent({ timeout: 900000 })).padEnd(20), '->', st)
  for (let k = 0; k < 6; k++) await tab.locator('.tab').nth(k).click({ timeout: 900000 })
}
// Unreal options
await tab.locator('.tab').nth(2).click()
await tab.check('#ueSub'); await tab.check('input[name=ueAs][value=function]')
console.log('unreal function+substrate export has slab:', (await tab.locator('#dump').textContent()).includes('SubstrateSlabBSDF'))
// a lit look on the box, with each profile
await tab.selectOption('#look', { label: 'Dusty Metal' }); await tab.waitForTimeout(600)
for (const p of ['blender', 'unreal', 'godot']) { await tab.selectOption('#profile', p); await tab.waitForTimeout(250) }
await tab.selectOption('#profile', 'rico')
await tab.evaluate(() => window.scrollTo(0, 0))
await tab.screenshot({ path: out + '/studio-lit.png' })
// node view
await tab.locator('#viewNodes').click(); await tab.waitForTimeout(300)
console.log('node boxes drawn:', await tab.locator('#nodesBox g.n').count())
await tab.screenshot({ path: out + '/studio-nodes.png' })
await tab.locator('#viewCode').click()
if (model) {
  await tab.setInputFiles('#modelIn', model); await tab.waitForTimeout(1500)
  console.log('model:', await tab.locator('#modelInfo').textContent())
  await tab.locator('#prepBtn').click()
  await tab.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 180000 })
  console.log('prepared:', await tab.locator('#modelInfo').textContent())
  await tab.waitForTimeout(600)
  await tab.evaluate(() => window.scrollTo(0, 0))
  await tab.screenshot({ path: out + '/studio-model.png' })
}
await tab.locator('#src').fill('name "x";\nvoid main() {\n  float a = foo * 2.0;\n  color = vec3(a);\n}\n')
await tab.waitForTimeout(500)
console.log('error shown ->', await tab.locator('#status').textContent())
await tab.setViewportSize({ width: 400, height: 900 })
await tab.selectOption('#look', '2'); await tab.waitForTimeout(500)
console.log('page wider than phone?', await tab.evaluate(() => document.documentElement.scrollWidth > innerWidth))
await tab.screenshot({ path: out + '/studio-phone.png' })
console.log('console errors:', errors)
await browser.close()
