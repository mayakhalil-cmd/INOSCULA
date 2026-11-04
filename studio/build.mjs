// Builds Inoscula Studio into one HTML file.
//   node studio/build.mjs <three.module.min.js> <out-dir> [fonts-dir]
// Writes inoscula-studio.html (works offline: three.js and the fonts are inside the file) and
// inoscula-studio.web.html (loads three.js from a CDN, for hosting).
import fs from 'node:fs'
import path from 'node:path'
import { stripTypeScriptTypes } from 'node:module'

const [threeFile, outDir, fontDir] = process.argv.slice(2)
const files = ['src/cards.ts', 'src/spec.ts', 'src/code.ts', 'src/targets/three.ts', 'src/targets/godot.ts', 'src/targets/hlsl.ts', 'src/targets/blender.ts', 'src/lang.ts', 'src/compat.ts', 'src/nodes.ts', 'src/native.ts']
let bundle = ''
for (const f of files) {
  const js = stripTypeScriptTypes(fs.readFileSync(f, 'utf8'))
    .split('\n').filter((l) => !/^\s*import\s/.test(l)).join('\n')
    .replace(/^export (class|const|function|let)/gm, '$1')
  bundle += `// ---- ${f}\n${js}\n`
}
const groups = {
  'Painterly': [['oil-paint', 'Sphere'], ['wet-stroke', 'Puppet'], ['hand-painted', 'Puppet'], ['oil-strokes', 'Puppet'], ['paint-strokes', 'Puppet'], ['painted-planes', 'Knot'], ['paint-with-light', 'Puppet'], ['painted-character', 'Puppet']],
  'Stylised': [['paint-bands', 'Knot'], ['hard-reflections', 'Knot'], ['comic-print', 'Knot'], ['mono-ink', 'Puppet'], ['engraving', 'Knot'], ['grain-gradient', 'Puppet'], ['iridescent', 'Knot']],
  'Stop motion and craft': [['claymation', 'Puppet']],
}
const looks = Object.entries(groups).flatMap(([group, list]) => list.map(([n, shape]) => {
  const code = fs.readFileSync(`looks/${n}.inoscula`, 'utf8')
  const title = /name "([^"]+)"/.exec(code)[1]
  return { title, file: `${n}.inoscula`, code, shape, group }
}))
for (const f of fs.readdirSync('looks')) if (!Object.values(groups).flat().some(([n]) => `${n}.inoscula` === f)) console.warn('look not in the menu:', f)
let html = fs.readFileSync('studio/studio.html', 'utf8')
const font64 = (f) => fs.readFileSync(path.join(fontDir, f)).toString('base64')
const fonts = fontDir ? `@font-face { font-family: 'Courier Prime'; font-weight: 400; font-display: swap; src: url(data:font/woff2;base64,${font64('courier-prime-latin-400-normal.woff2')}) format('woff2'); }
@font-face { font-family: 'Courier Prime'; font-weight: 700; font-display: swap; src: url(data:font/woff2;base64,${font64('courier-prime-latin-700-normal.woff2')}) format('woff2'); }
@font-face { font-family: 'VT323'; font-weight: 400; font-display: swap; src: url(data:font/woff2;base64,${font64('vt323-latin-400-normal.woff2')}) format('woff2'); }` : ''
html = html.replace('/*FONTS*/', fonts).replace('/*INOSCULA_BUNDLE*/', () => bundle).replace('/*LOOKS*/', () => JSON.stringify(looks))
const three = fs.readFileSync(threeFile, 'utf8')
const jsm = path.join(path.dirname(threeFile), '..', 'examples', 'jsm')
const addons = ['loaders/GLTFLoader.js', 'loaders/OBJLoader.js', 'exporters/GLTFExporter.js', 'utils/BufferGeometryUtils.js']
const data = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
const offlineMap = { three: data(three) }
for (const a of addons) offlineMap['three/addons/' + a] = data(fs.readFileSync(path.join(jsm, a), 'utf8').replace(/'\.\.\/utils\/BufferGeometryUtils\.js'/g, "'three/addons/utils/BufferGeometryUtils.js'"))
const offline = `<script type="importmap">${JSON.stringify({ imports: offlineMap })}</script>`
const web = `<script type="importmap">${JSON.stringify({ imports: { three: 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js', 'three/addons/': 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/' } })}</script>`
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'inoscula-studio.html'), `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${html.replace('<!--THREE_LOADER-->', () => offline)}\n</head></html>`.replace('</style>\n\n<div class="app">', '</style>\n</head><body>\n<div class="app">').replace(/\n<\/head><\/html>$/, '\n</body></html>'))
fs.writeFileSync(path.join(outDir, 'inoscula-studio.web.html'), html.replace('<!--THREE_LOADER-->', () => web))
console.log('built', fs.statSync(path.join(outDir, 'inoscula-studio.html')).size, 'bytes offline,', fs.statSync(path.join(outDir, 'inoscula-studio.web.html')).size, 'bytes web')
