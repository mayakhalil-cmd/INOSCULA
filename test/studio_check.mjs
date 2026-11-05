// Drives Inoscula Studio in a real browser: every look compiles, every export tab builds, the node view draws,
// the preview profiles switch, the Check tab runs every exporter, objects and parameters can be added, scripts
// run, a model loads and gets its shape data, and errors point at the right line.
//   node test/studio_check.mjs <inoscula-studio.html> <out-dir> [model.glb]
import { chromium } from 'playwright'
const [file, out, model] = process.argv.slice(2)
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const tab = await browser.newPage({ viewport: { width: 1300, height: 850 } })
tab.on('dialog', (d) => d.accept())
let errors = 0
tab.on('console', (m) => { if (m.type() === 'error') { errors++; console.log('console error:', m.text().slice(0, 400)) } })
tab.on('pageerror', (e) => { errors++; console.log('exception:', e.message) })
await tab.goto('file://' + file)
// skip the first-visit tour
await tab.evaluate(() => localStorage.setItem('inoscula-toured', '1'))
await tab.waitForFunction('window.__ready', null, { timeout: 900000 })
const n = await tab.locator('#look option').count()
for (let i = 0; i < n; i++) {
  await tab.selectOption('#look', String(i), { timeout: 900000 })
  await tab.waitForTimeout(350)
  await tab.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 600000 })
  const st = (await tab.locator('#status').textContent({ timeout: 900000 })).slice(0, 120)
  console.log((await tab.locator('#look option').nth(i).textContent({ timeout: 900000 })).padEnd(20), '->', st)
  for (let k = 0; k < 6; k++) await tab.locator('#progs button').nth(k).click({ timeout: 900000 })
}
// a lit look, with each profile
await tab.selectOption('#look', { label: 'Claymation' }); await tab.waitForTimeout(600)
// Unreal options
await tab.locator('#progs [data-p=unreal]').click()
await tab.check('input[name=part][value=function]'); await tab.check('#ueSub')
console.log('unreal function+substrate export has slab:', (await tab.locator('#dump').textContent()).includes('SubstrateSlabBSDF'))
await tab.locator('#progs [data-p=inoscula]').click()
// Check tab: every exporter, for real
await tab.locator('#viewCheck').click(); await tab.waitForTimeout(300)
console.log('check:', (await tab.locator('#checkBox .cbig b').textContent()), '| rows:', await tab.locator('#checkBox .crow').count())
await tab.locator('#viewCode').click()
// the scene: add, select, duplicate, delete
await tab.locator('[data-add=Box]').click(); await tab.waitForTimeout(800)
await tab.keyboard.press('Control+d'); await tab.waitForTimeout(800)
console.log('objects after add and duplicate:', await tab.locator('#outliner li').count())
await tab.locator('#outliner li').first().click({ timeout: 300000 }); await tab.keyboard.press('Delete'); await tab.waitForTimeout(300)
console.log('objects after delete:', await tab.locator('#outliner li').count())
// + Add parameter
await tab.locator('#addParamBtn').click(); await tab.locator('#paramKind [data-k=toggle]').click(); await tab.fill('#paramLabel', 'Wet Look'); await tab.fill('#paramGroup', 'Extras')
await tab.locator('#paramOk').click(); await tab.waitForTimeout(500)
console.log('added switch:', await tab.locator('#params .grp .switch').count(), '| status:', (await tab.locator('#status').textContent()).slice(0, 60))
// a script adds a toolbar button
await tab.locator('#viewScripts').click(); await tab.locator('#scriptNew').click()
await tab.fill('#scriptSrc', "inoscula.ui.addButton('Hello', () => inoscula.toast('hi')); inoscula.log(inoscula.params.list().length + ' params')")
await tab.locator('#scriptRun').click(); await tab.waitForTimeout(200)
console.log('script:', await tab.locator('#scriptOut').textContent(), '| toolbar:', await tab.locator('#userTools').textContent())
await tab.locator('#viewCode').click()
// menus open and run
await tab.locator('#menus button', { hasText: 'Help' }).click(); await tab.locator('#menuPop button', { hasText: 'Keyboard shortcuts' }).click()
console.log('help open:', !(await tab.locator('#helpSheet').isHidden())); await tab.keyboard.press('Escape')
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
// shaders pasted from elsewhere: GLSL from Shadertoy, a Unity shader, one that reads a picture
const fsr = await import('node:fs')
for (const f of ['test/glsl/shadertoy-rings.glsl', 'test/hlsl/plain-ps.hlsl', 'test/hlsl/urp-unlit.shader', 'test/hlsl/unreal-custom.hlsl']) {
  await tab.locator('#src').fill(fsr.readFileSync(new URL('../' + f, import.meta.url), 'utf8'), { timeout: 900000 })
  await tab.waitForTimeout(900)
  await tab.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 600000 })
  console.log('pasted', f.padEnd(30), '->', (await tab.locator('#status').textContent()).slice(0, 160))
  for (const k of ['godot', 'unreal', 'blender']) { await tab.locator(`#progs [data-p=${k}]`).click({ timeout: 900000 }); }
  await tab.locator('#progs [data-p=inoscula]').click() // back to the editor
}
await tab.screenshot({ path: out + '/studio-pasted.png' })
await tab.locator('#toIno').click({ timeout: 900000 }); await tab.waitForTimeout(800)
await tab.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 900000 })
console.log('turned into Inoscula code ->', (await tab.locator('#status').textContent()).slice(0, 100), '|', await tab.locator('#fileName').textContent())
await tab.locator('#src').fill('Shader "Unlit/Textured" { Properties { _MainTex ("Texture", 2D) = "white" {} }\nSubShader { Pass { CGPROGRAM\n#pragma vertex vert_img\n#pragma fragment frag\n#include "UnityCG.cginc"\nsampler2D _MainTex;\nfixed4 frag(v2f_img i) : SV_Target { return tex2D(_MainTex, i.uv); }\nENDCG } } }\n', { timeout: 900000 })
await tab.waitForTimeout(700)
console.log('picture error ->', await tab.locator('#status').textContent())
await tab.locator('#src').fill('name "x";\nvoid main() {\n  float a = foo * 2.0;\n  color = vec3(a);\n}\n')
await tab.waitForTimeout(500)
console.log('error shown ->', await tab.locator('#status').textContent())
await tab.setViewportSize({ width: 400, height: 900 })
await tab.selectOption('#look', '2'); await tab.waitForTimeout(500)
console.log('page wider than phone?', await tab.evaluate(() => document.documentElement.scrollWidth > innerWidth))
await tab.screenshot({ path: out + '/studio-phone.png' })
console.log('console errors:', errors)
await browser.close()
