// Compiles every example's and look's GLSL and HLSL with glslangValidator (the Khronos reference compiler):
// the three.js / RICO shader, the Unity file, and the Unreal Custom node exactly as Unreal would wrap it, in
// material, Material Function and Substrate form.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { check, toThree, toUnity, toUnreal } from '../src/index.ts'
import { parse } from '../src/lang.ts'

const tmp = process.argv[2]
let bad = 0
const run = (file: string, extra: string[]) => {
  try { execFileSync('glslangValidator', [...extra, file], { stdio: 'pipe' }); return 'ok' }
  catch (e: any) { bad++; return 'FAIL\n' + String(e.stdout) }
}
const HL = ['-D', '-V', '-o', tmp + '/x.spv', '-e', 'main', '-S', 'frag']
const sources: [string, any][] = [
  ...fs.readdirSync('examples').map((f) => [f, JSON.parse(fs.readFileSync('examples/' + f, 'utf8'))] as [string, any]),
  ...fs.readdirSync('looks').map((f) => [f, parse(fs.readFileSync('looks/' + f, 'utf8'))] as [string, any]),
]
const PIN: Record<string, string> = { UV: 'float2', ObjPos: 'float3', ObjNrm: 'float3', WPos: 'float3', WNrm: 'float3', CamVec: 'float3', Time: 'float', LightDir: 'float4', LightColor: 'float4', VCol: 'float4' }
const OUT: Record<string, string> = { CMOT_FLOAT1: 'float', CMOT_FLOAT3: 'float3' }
function unrealWrap(py: string, ir: any) {
  const code = JSON.parse(py.match(/custom\.set_editor_property\("code", (".*")\)/)![1])
  const pins = [...py.matchAll(/pins\.append\(\("([^"]+)"/g)].map((m) => m[1])
  const outs = [...py.matchAll(/CustomOutput\(output_name="([^"]+)", output_type=unreal\.CustomMaterialOutputType\.(\w+)\)/g)].map((m) => `inout ${OUT[m[2]]} ${m[1]}`)
  const sig = [...pins.map((p) => `${PIN[p] ?? (ir.params.find((q: any) => 'P_' + q.id === p)?.t === 'vec3' ? 'float4' : 'float')} ${p}`), ...outs]
  // Unreal pastes Custom node code inside a function. Its compilers accept the struct there; glslang only accepts
  // structs with methods at file scope, so the struct is lifted out for this check. The code itself is unchanged.
  const cut = code.indexOf('InosculaFn G;')
  return `${code.slice(0, cut)}\nfloat4 CustomExpression0(${sig.join(', ')}) {\n${code.slice(cut)}\n}\nfloat4 main() : SV_Target { return 0; }\n`
}
for (const [f, g] of sources) {
  const ir = check(g)
  const t = toThree(ir)
  const pre = `#version 300 es\nprecision highp float;\nprecision highp int;\nuniform mat4 modelMatrix, viewMatrix, projectionMatrix;\nuniform vec3 cameraPosition;\n`
  const res: string[] = []
  if (!ir.lit) {
    fs.writeFileSync(`${tmp}/a.frag`, pre + 'out vec4 inosculaFrag;\n' + t.fragmentShader.replace(/varying/g, 'in').replace('gl_FragColor', 'inosculaFrag').replace('#include <colorspace_fragment>', '').replace('#include <tonemapping_fragment>', ''))
    fs.writeFileSync(`${tmp}/a.vert`, pre + 'in vec3 position, normal; in vec2 uv; in vec3 color;\n' + t.vertexShader.replace(/varying/g, 'out'))
    res.push('glsl ' + run(`${tmp}/a.frag`, []), 'vert ' + run(`${tmp}/a.vert`, []))
  } else res.push('glsl (lit: checked in the browser)')
  fs.writeFileSync(`${tmp}/u.hlsl`, toUnity(ir) + `\nfloat4 main() : SV_Target { return 0; }\n`)
  res.push('unity ' + run(`${tmp}/u.hlsl`, HL))
  const forms = ir.lit ? [{}, { substrate: true }, { as: 'function' as const, substrate: true }] : [{}, { as: 'function' as const }]
  for (const o of forms) {
    fs.writeFileSync(`${tmp}/ue.hlsl`, unrealWrap(toUnreal(ir, o), ir))
    res.push(`unreal${(o as any).as ? '-function' : ''}${(o as any).substrate ? '-substrate' : ''} ` + run(`${tmp}/ue.hlsl`, HL))
  }
  console.log(f.padEnd(28), res.join(' | '))
}
process.exit(bad ? 1 : 0)
