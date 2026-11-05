// Shader reader test. Draws each shader in test/glsl and test/hlsl twice in a real browser: once as the
// original (the way Shadertoy, three.js, TouchDesigner, Unity or Unreal would run it) and once as the Inoscula
// graph the reader made from it, printed for three.js. Then compares every pixel as it would show on screen.
// HLSL originals are built by the DirectX compiler and turned into GLSL by SPIRV-Cross, so they do not go
// through Inoscula's own HLSL reading at all. Set DXC and SPIRV_CROSS if those are not on the PATH.
//   node test/glsl_compare.mjs <three.module.js> <out_dir> [shader dir ...]
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
import { read, check, toThree, safeId, looksLikeHLSL, RESOLUTION } from '../src/index.ts'

const [threeFile, outDir, ...given] = process.argv.slice(2)
const dirs = given.length ? given : ['glsl', 'hlsl'].map((d) => new URL('./' + d, import.meta.url).pathname)
// the id the reader gives a uniform's slider
const paramId = (n) => safeId(n.replace(/^(u_|_+)/, ''))
const DXC = process.env.DXC ?? 'dxc', SPIRV_CROSS = process.env.SPIRV_CROSS ?? 'spirv-cross'
fs.mkdirSync(outDir, { recursive: true })
const SIZE = 128
const TIMES = [0.0, 1.37, 7.9]
const R = RESOLUTION

// the original, made into a WebGL 2 shader that runs on a square of UVs exactly as the reader assumes
function original(src, graph) {
  let s = src.replace(/^\s*#version.*$/m, '').replace(/^\s*precision\s+\w+\s+float\s*;/m, '')
  const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const es1 = /\bgl_FragColor\b/.test(code) || /\bvarying\b/.test(code)
  s = s.replace(/\bgl_FragCoord\b/g, '_fragCoord').replace(/\bvarying\b/g, 'in').replace(/\btexture2D\b/g, 'texture')
  const decl = (re) => re.test(s)
  const head = ['#version 300 es', 'precision highp float;', 'precision highp int;', 'in vec2 _uv;', `const vec4 _fc0 = vec4(0.0);`,
    `#define _fragCoord vec4(_uv * ${R.toFixed(1)}, 0.5, 1.0)`]
  if (es1) head.push('out vec4 _out;', '#define gl_FragColor _out')
  const uni = []
  const want = (n, t) => { if (new RegExp(`\\b${n}\\b`).test(s) && !decl(new RegExp(`(uniform|in)\\s+\\w+\\s+${n}\\b`))) uni.push(`uniform ${t} ${n};`) }
  if (/\bmainImage\b/.test(s)) { want('iTime', 'float'); want('iResolution', 'vec3'); want('iMouse', 'vec4'); want('iFrame', 'int'); want('iTimeDelta', 'float') }
  if (/\bvUV\b/.test(s) && !decl(/in\s+vec\d\s+vUV/)) head.push('#define vUV vec3(_uv, 0.0)', '#define TDOutputSwizzle(c) (c)')
  // what TouchDesigner's GLSL TOP gives a shader: its texture info, pass number, dither and color helpers
  if (/\bvUV\b/.test(s)) {
    const info = `TDTexInfo(vec4(${(1 / R).toFixed(8)}, ${(1 / R).toFixed(8)}, ${R.toFixed(1)}, ${R.toFixed(1)}), vec4(1.0, 1.0, 0.0, 0.0))`
    head.push('struct TDTexInfo { vec4 res; vec4 depth; };', `const TDTexInfo uTDOutputInfo = ${info};`,
      ...['uTD2DInfos', 'uTD3DInfos', 'uTD2DArrayInfos', 'uTDCubeInfos'].map((n) => `const TDTexInfo ${n}[8] = TDTexInfo[8](${Array(8).fill(info).join(', ')});`),
      'const int uTDPass = 0;', 'const int uTDCurrentDepth = 0;', '#define TDDither(c) (c)',
      'vec3 TDHSVToRGB(vec3 c) { vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0); vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www); return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y); }',
      'vec3 TDRGBToHSV(vec3 c) { vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0); vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g)); vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r)); float d = q.x - min(q.w, q.y); return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1.0e-10)), d / (q.x + 1.0e-10), q.x); }')
  }
  s = s.replace(/^\s*(in)\s+vec2\s+(\w+)\s*;/gm, (_m, _q, n) => `#define ${n} _uv`)
  let main = ''
  if (/\bmainImage\b/.test(s) && !/void\s+main\s*\(/.test(s)) { head.push('out vec4 _out;'); main = '\nvoid main() { vec4 c = vec4(0.0, 0.0, 0.0, 1.0); mainImage(c, _uv * iResolution.xy); _out = vec4(c.rgb, 1.0); }' }
  // the parameters get the same starting values the reader gave them
  const values = {}
  for (const m of s.matchAll(/uniform\s+(\w+)\s+(\w+)\s*;/g)) {
    const [, , n] = m
    const p = graph.params?.find((q) => q.id === paramId(n))
    if (p) values[n] = p.default
    const w = graph.params?.find((q) => q.id === paramId(n) + '_w')
    if (w && Array.isArray(values[n])) values[n] = [...values[n], w.default]
  }
  return { frag: [...head, ...uni, s, main].join('\n'), values }
}

// an HLSL original: DirectX compiler to SPIR-V, SPIRV-Cross to GLSL ES 3.0
// an entry that returns a struct holding an SV_Target field
function structEntry(src) {
  for (const m of src.matchAll(/\bstruct\s+(\w+)\s*\{([^}]*)\}/g)) {
    if (!/:\s*SV_Target/i.test(m[2])) continue
    const f = new RegExp('\\b' + m[1] + '\\s+(\\w+)\\s*\\(').exec(src)
    if (f) return f
  }
  return null
}
function hlslOriginal(src, graph) {
  const tmp = fs.mkdtempSync(os.tmpdir() + '/hlsl-')
  let code = src, entry
  const unity = /\bShader\s*"/.test(src)
  if (unity) {
    code = /\b(?:CGPROGRAM|HLSLPROGRAM)\b([\s\S]*?)\b(?:ENDCG|ENDHLSL)\b/.exec(src)[1]
    entry = /#\s*pragma\s+fragment\s+(\w+)/.exec(code)[1]
  } else if (!/\b\w+\s+\w+\s*\([^;{]*\)\s*(?::\s*\w+\s*)?\{/.test(src.replace(/\/\/.*$/gm, ''))) {
    // an Unreal Custom node: Unreal puts the code in a function whose parameters are the node's inputs
    const inputs = (graph.params ?? []).map((p) => p.id)
    const ret = /\breturn\s+(?:float|half)([234])\s*\(/.exec(src)?.[1] ?? '3'
    const all = [...new Set(['Time', ...inputs])]
    code = `cbuffer Inputs { ${all.map((n) => `float ${n};`).join(' ')} };\nfloat${ret} CustomExpression0(float2 UV)\n{\n${src}\n}\nfloat4 main(float2 uv : TEXCOORD0) : SV_Target { float${ret} c = CustomExpression0(uv); return float4(${ret === '4' ? 'c.rgb' : ret === '2' ? 'c, 0.0' : 'c'}, 1.0); }\n`
    entry = 'main'
  } else entry = (/(\w+)\s*\([^)]*\)\s*:\s*SV_Target/i.exec(src) ?? /(\w+)\s*\([^)]*:\s*SV_Target\d?\s*\)/i.exec(src) ?? structEntry(src))[1]
  fs.writeFileSync(tmp + '/s.hlsl', code)
  execFileSync(DXC, ['-spirv', '-T', 'ps_6_0', '-E', entry, '-I', new URL('./hlsl_stubs', import.meta.url).pathname, tmp + '/s.hlsl', '-Fo', tmp + '/s.spv'], { stdio: 'pipe' })
  let s = execFileSync(SPIRV_CROSS, ['--version', '300', '--es', '--glsl-emit-ubo-as-plain-uniforms', tmp + '/s.spv']).toString()
  fs.rmSync(tmp, { recursive: true })
  // the struct uniforms SPIRV-Cross makes from cbuffers: each field gets the reader's starting value
  const values = {}, timed = []
  const fields = new Map()
  for (const m of s.matchAll(/struct\s+(\w+)\s*\{([^}]*)\}/g)) fields.set(m[1], [...m[2].matchAll(/(\w+)\s+(\w+)\s*;/g)].map((x) => [x[2], x[1]]))
  for (const m of s.matchAll(/uniform\s+(?:highp\s+|mediump\s+)?(\w+)\s+(\w+)\s*;/g)) {
    for (const [f, type] of fields.get(m[1]) ?? [[m[2], m[1]]]) {
      const n = fields.has(m[1]) ? `${m[2]}.${f}` : f
      if (['Time', 'iTime', 'time', 'gTime'].includes(f)) { timed.push([n, 1]); continue }
      if (['iResolution', 'Resolution', 'resolution'].includes(f)) { values[n] = type === 'vec3' ? [R, R, 1] : [R, R]; continue }
      if (f === '_Time') { timed.push([n, 4]); continue }
      const id = paramId(f)
      const p = graph.params?.find((q) => q.id === id)
      const w = graph.params?.find((q) => q.id === id + '_w')
      if (p) values[n] = type === 'vec4' ? [...p.default, w ? w.default : 1] : p.default
      else if (type === 'vec4') values[n] = [1, 1, 1, 1]
    }
  }
  s = s.replace(/^#version.*$/m, '').replace(/^precision\s+\w+\s+float\s*;/m, '').replace(/\bgl_FragCoord\b/g, '_fragCoord')
  s = s.replace(/^(?:layout\([^)]*\)\s*)?in\s+(?:highp\s+|mediump\s+)?vec2\s+(\w+)\s*;/gm, (_m, n) => `#define ${n} _uv`)
  const head = ['#version 300 es', 'precision highp float;', 'precision highp int;', 'in vec2 _uv;', `#define _fragCoord vec4(_uv * ${R.toFixed(1)}, 0.5, 1.0)`]
  return { frag: [...head, s].join('\n'), values, timed }
}

const page = `<!doctype html><canvas id=a width=${SIZE} height=${SIZE}></canvas><canvas id=b width=${SIZE} height=${SIZE}></canvas>
<script type=importmap>{"imports":{"three":"/three.js"}}</script>
<script type=module>
import * as THREE from 'three'
const N = ${SIZE}, R = ${R}
window.raw = (frag, values, times, timed = []) => {
  const gl = document.getElementById('a').getContext('webgl2')
  gl.getExtension('EXT_color_buffer_float')
  const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s }
  const p = gl.createProgram()
  gl.attachShader(p, sh(gl.VERTEX_SHADER, '#version 300 es\\nin vec2 pos; out vec2 _uv; void main() { _uv = pos * 0.5 + 0.5; gl_Position = vec4(pos, 0.0, 1.0); }'))
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, frag))
  gl.bindAttribLocation(p, 0, 'pos')
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p))
  const fb = gl.createFramebuffer(), tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, N, N)
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  gl.useProgram(p); gl.viewport(0, 0, N, N)
  const out = []
  for (const t of times) {
    const set = (n, v) => { const l = gl.getUniformLocation(p, n); if (!l) return; if (typeof v === 'number') { const info = gl.getActiveUniform(p, [...Array(gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS)).keys()].find((i) => gl.getActiveUniform(p, i).name === n)); if (info.type === gl.INT || info.type === gl.BOOL) gl.uniform1i(l, v); else gl.uniform1f(l, v) } else gl['uniform' + v.length + 'fv'](l, v) }
    for (const n of ['iTime', 'iGlobalTime', 'u_time', 'uTime', 'time', 'TIME']) set(n, t)
    set('iResolution', [R, R, 1]); for (const n of ['u_resolution', 'uResolution', 'resolution', 'RENDERSIZE']) set(n, [R, R])
    set('iMouse', [0, 0, 0, 0]); set('u_mouse', [R / 2, R / 2]); set('mouse', [0.5, 0.5]); set('iFrame', Math.floor(t * 60)); set('iTimeDelta', 1 / 60)
    for (const [n, v] of Object.entries(values)) set(n, v)
    for (const [n, k] of timed) set(n, k === 1 ? t : [t / 20, t, t * 2, t * 3])
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    const px = new Float32Array(N * N * 4); gl.readPixels(0, 0, N, N, gl.RGBA, gl.FLOAT, px)
    out.push(Array.from(px))
  }
  return out
}
window.conv = (sh, times) => {
  const r = new THREE.WebGLRenderer({ canvas: document.getElementById('b'), antialias: false })
  const rt = new THREE.WebGLRenderTarget(N, N, { type: THREE.FloatType, depthBuffer: false })
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3))
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3))
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2))
  g.setIndex([0, 1, 2, 2, 1, 3])
  const u = {}
  for (const [k, v] of Object.entries(sh.uniforms)) u[k] = { value: Array.isArray(v) ? (v.length === 2 ? new THREE.Vector2(...v) : new THREE.Vector3(...v)) : v }
  const mat = new THREE.ShaderMaterial({ vertexShader: sh.vertexShader, fragmentShader: sh.fragmentShader, uniforms: u, side: THREE.DoubleSide, transparent: false })
  const m = new THREE.Mesh(g, mat); m.frustumCulled = false
  const scene = new THREE.Scene(); scene.add(m)
  const out = []
  for (const t of times) {
    if (u.inoscula_time) u.inoscula_time.value = t
    r.setRenderTarget(rt); r.setClearColor(0x000000, 0); r.clear()
    r.render(scene, new THREE.Camera())
    const px = new Float32Array(N * N * 4); r.readRenderTargetPixels(rt, 0, 0, N, N, px)
    out.push(Array.from(px))
  }
  return out
}
window.picture = (a, b) => {
  const c = document.createElement('canvas'); c.width = N * 3; c.height = N
  const x = c.getContext('2d'); const im = x.createImageData(N * 3, N)
  for (let yy = 0; yy < N; yy++) for (let xx = 0; xx < N; xx++) {
    const i = ((N - 1 - yy) * N + xx) * 4
    const put = (col, r, g, bb) => { const o = (yy * N * 3 + col * N + xx) * 4; im.data[o] = r; im.data[o + 1] = g; im.data[o + 2] = bb; im.data[o + 3] = 255 }
    put(0, a[i], a[i + 1], a[i + 2]); put(1, b[i], b[i + 1], b[i + 2])
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]))
    put(2, Math.min(255, d * 20), d > 2 ? 0 : 40, 0)
  }
  x.putImageData(im, 0, 0); return c.toDataURL('image/png')
}
window.ready = true
</script>`

const server = http.createServer((req, res) => {
  if (req.url === '/three.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(fs.readFileSync(threeFile)) }
  else { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page) }
}).listen(0)
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const tab = await browser.newPage()
tab.on('console', (m) => { if (m.type() === 'error') console.log('  page:', m.text().slice(0, 400)) })
await tab.goto(`http://localhost:${server.address().port}/`)
await tab.waitForFunction('window.ready')

// what the screen shows: 0..255, clamped. The original is already a display value; Inoscula's is linear.
const show = (v) => Math.round(255 * Math.min(1, Math.max(0, v)))
const enc = (v) => show(v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055)

let failed = false
const report = []
const files = dirs.flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d).sort().map((f) => [d, f]) : []))
for (const [dir, f] of files) {
  const src = fs.readFileSync(`${dir}/${f}`, 'utf8')
  let r
  try { r = read(src) } catch (e) { console.log(f.padEnd(28), 'FAILED to read:', e.message); failed = true; continue }
  const sh = toThree(check(r.graph))
  for (const p of r.graph.params ?? []) sh.uniforms['p_' + p.id] = p.default
  let o
  if (looksLikeHLSL(src)) {
    try { o = hlslOriginal(src, r.graph) } catch (e) { console.log(f.padEnd(28), 'the DirectX compiler or SPIRV-Cross could not build the original:', String(e.stderr ?? e.message).slice(0, 300)); failed = true; continue }
  } else o = original(src, r.graph)
  let A, Bv
  try { A = await tab.evaluate(([s, v, t, tm]) => window.raw(s, v, t, tm), [o.frag, o.values, TIMES, o.timed ?? []]) } catch (e) { console.log(f.padEnd(28), 'the original does not compile here:', e.message.slice(0, 300)); failed = true; continue }
  Bv = await tab.evaluate(([s, t]) => window.conv(s, t), [sh, TIMES])
  let n = 0, same = 0, close = 0, max = 0
  const cut = r.graph.surface === 'cutout'
  const lin = r.style === 'unity' || r.style === 'unreal'
  for (let k = 0; k < TIMES.length; k++) {
    const a = A[k], b = Bv[k]
    const da = [], db = []
    for (let i = 0; i < a.length; i += 4) {
      // a cut out pixel is simply not drawn in the original; Inoscula draws it with alpha 0
      const hole = cut && b[i + 3] < 0.5, gone = a[i + 3] === 0 && a[i] === 0 && a[i + 1] === 0 && a[i + 2] === 0
      // Unity and Unreal write linear color, as Inoscula does; everything else writes a screen color
      const av = gone ? [0, 0, 0] : lin ? [enc(a[i]), enc(a[i + 1]), enc(a[i + 2])] : [show(a[i]), show(a[i + 1]), show(a[i + 2])]
      const bv = hole ? [0, 0, 0] : [enc(b[i]), enc(b[i + 1]), enc(b[i + 2])]
      da.push(...av, 255); db.push(...bv, 255)
      const d = Math.max(...av.map((x, j) => Math.abs(x - bv[j])))
      n++; if (d === 0) same++; if (d <= 2) close++; max = Math.max(max, d)
    }
    if (k === 1) {
      const png = await tab.evaluate(([x, y]) => window.picture(x, y), [da, db])
      fs.writeFileSync(`${outDir}/${f.replace(/\.\w+$/, '')}.png`, Buffer.from(png.split(',')[1], 'base64'))
    }
  }
  const pass = close / n >= 0.99
  if (!pass) failed = true
  const row = { shader: f, style: r.style, nodes: r.graph.nodes.length, identical: `${(100 * same / n).toFixed(2)}%`, within_2: `${(100 * close / n).toFixed(2)}%`, max_diff: max, result: pass ? 'pass' : 'FAIL' }
  report.push(row)
  console.log(f.padEnd(28), row.style.padEnd(14), String(row.nodes).padStart(5), 'nodes ', row.identical.padStart(8), 'identical', row.within_2.padStart(8), 'within 2/255  max', String(max).padStart(3), ' ', row.result)
}
fs.writeFileSync(`${outDir}/glsl.json`, JSON.stringify(report, null, 2))
await browser.close(); server.close()
process.exit(failed ? 1 : 0)
