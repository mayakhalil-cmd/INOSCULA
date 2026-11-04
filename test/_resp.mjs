import { chromium } from 'playwright'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const t = await b.newPage({ viewport: { width: 1100, height: 800 } })
let errs = 0; t.on('pageerror', (e) => { errs++; console.log('exception', e.message) })
await t.goto('file://' + process.argv[2]); await t.waitForFunction('window.__ready', null, { timeout: 900000 })
const names = await t.locator('#look option').allTextContents()
for (const want of ['Impasto', 'Wet Stroke', 'Hand Painted']) {
  const i = names.indexOf(want)
  const t0 = Date.now()
  await t.selectOption('#look', String(i), { timeout: 900000 })
  const t1 = Date.now()
  const clickMs = await t.evaluate(async () => { const s = performance.now(); document.querySelector('.tab').click(); return performance.now() - s })
  await t.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 600000 })
  console.log(want.padEnd(12), 'select', t1 - t0, 'ms | tab click while compiling', Math.round(clickMs), 'ms | ready after', ((Date.now() - t0) / 1000).toFixed(1), 's')
}
console.log('errors', errs)
await b.close()
