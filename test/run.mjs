// Runs every check. Needs: Node 22.18+, glslangValidator, Python with the bpy module (pip install bpy),
// Playwright with Chromium, and THREE=<path to three.module.js> (RICO's copy). GODOT=<godot binary> adds Godot
// (Vulkan; on a machine with no GPU, Mesa's lavapipe works).
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { parse } from '../src/lang.ts'
import { check, toBlender } from '../src/index.ts'
const sh = (c) => { console.log('\n$ ' + c); execSync(c, { stdio: 'inherit' }) }
const T = 'test-out'
fs.rmSync(T, { recursive: true, force: true }); fs.mkdirSync(T + '/rt/graphs', { recursive: true }); fs.mkdirSync(T + '/looks/graphs', { recursive: true })
const three = process.env.THREE ?? 'node_modules/three/build/three.module.js'
const godot = process.env.GODOT ? `GODOT_ARGS="--rendering-driver vulkan --rendering-method forward_plus" node test/godot_parity.ts` : ''

// 1. every target compiles
sh('node bin/inoscula.ts examples/*.inoscula.json --out out')
sh(`node test/validate.ts ${T}`)

// 2. examples: Blender bake vs RICO, as rendered and with identical inputs (the maths alone)
const bl = 'out/toon/toon.blender.py out/ink/ink.blender.py out/kitchen-sink/kitchen-sink.blender.py'
sh(`python3 test/blender_bake.py ${T} ${bl}`)
sh(`node test/parity.mjs ${T}/blender.json ${three} ${T}`)
sh(`node test/parity.mjs ${T}/blender.json ${three} ${T} examples --exact`)
if (godot) sh(`${godot} ${T}/blender.json ${process.env.GODOT} ${T}/godot`)

// 3. the look library, written as code (unlit looks compared exactly; lit looks are checked by rendering, step 6)
const py = []
for (const f of fs.readdirSync('looks')) {
  const g = parse(fs.readFileSync('looks/' + f, 'utf8'))
  if (check(g).lit) continue
  const base = f.replace('.inoscula', '')
  fs.writeFileSync(`${T}/looks/graphs/${base}.json`, JSON.stringify(g))
  fs.writeFileSync(`${T}/looks/${base}.blender.py`, toBlender(check(g))); py.push(`${T}/looks/${base}.blender.py`)
}
sh(`python3 test/blender_bake.py ${T}/looks ${py.join(' ')}`)
sh(`node test/parity.mjs ${T}/looks/blender.json ${three} ${T}/looks ${T}/looks/graphs --exact`)
if (godot) sh(`${godot} ${T}/looks/blender.json ${process.env.GODOT} ${T}/looks/godot ${T}/looks/graphs`)

// 4. Blender -> Inoscula -> RICO, including a material made by hand
sh(`python3 test/blender_roundtrip.py ${T}/rt ${bl} test/artist_material.py`)
sh(`python3 test/blender_bake.py ${T}/rt test/artist_material.py ${bl}`)
sh(`node test/parity.mjs ${T}/rt/blender.json ${three} ${T}/rt ${T}/rt/graphs`)

// 4b. Voronoi, bit for bit against Blender's Voronoi Texture
fs.mkdirSync(`${T}/voronoi/graphs`, { recursive: true })
const vg = parse('name "Voronoi Check";\nvoid main() {\n  float d = voronoi(object_pos, 4.0, 1.0);\n  float q = voronoi(object_pos, 4.0, 0.7).position.x;\n  color = vec3(d, d.color.y, q * 0.25 + 0.5);\n}')
fs.writeFileSync(`${T}/voronoi/graphs/v.json`, JSON.stringify(vg)); fs.writeFileSync(`${T}/voronoi/v.blender.py`, toBlender(check(vg)))
sh(`python3 test/blender_bake.py ${T}/voronoi ${T}/voronoi/v.blender.py`)
sh(`node test/parity.mjs ${T}/voronoi/blender.json ${three} ${T}/voronoi ${T}/voronoi/graphs --exact`)

// 4c. Inoscula Live: browser, relay, real Blender and OSC, both directions
fs.writeFileSync(`${T}/claymation.blender.py`, toBlender(check(parse(fs.readFileSync('looks/claymation.inoscula', 'utf8')))))
sh(`node test/live_test.mjs ${T}/claymation.blender.py`)

// 5. RICO adapter and the studio
sh(`node test/rico_preview.mjs ${three} ${T}/rico-preview.png`)
sh(`node test/looks_preview.mjs ${three} ${T}/looks.png`)
if (fs.existsSync('dist/inoscula-studio.html')) { fs.mkdirSync(`${T}/studio`, { recursive: true }); sh(`node test/studio_check.mjs ${process.cwd()}/dist/inoscula-studio.html ${T}/studio${process.env.MODEL ? ' ' + process.env.MODEL : ''}`) }
// 6. render check: the same scene rendered by RICO, Blender (Cycles) and Godot, side by side
for (const look of ['claymation', 'comic-print', 'paint-bands', 'hard-reflections', 'oil-strokes', 'paint-strokes']) {
  sh(`node bin/inoscula-check.ts looks/${look}.inoscula --out ${T}/check --three ${three}${process.env.GODOT ? ' --godot ' + process.env.GODOT : ''}`)
}
console.log('\nAll checks ran. Pictures and numbers are in ' + T)
