// Compiles every HLSL output with DXC, the compiler Unreal 5 uses for Shader Model 6 (and Unity uses for DX12 and
// Vulkan). DXC is stricter than glslang's HLSL mode: it rejects one-argument float3(x), for example.
// Get dxc from https://github.com/microsoft/DirectXShaderCompiler/releases and put its bin folder on PATH.
// Usage: node test/dxc.ts <tmp folder>
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { check, toUnity, toUnreal } from '../src/index.ts'
import { toUnrealNative, unrealGraph } from '../src/native.ts'
import { parse } from '../src/lang.ts'
import { read } from '../src/read.ts'

const tmp = process.argv[2]
fs.mkdirSync(tmp, { recursive: true })
let bad = 0
const dxc = (src: string) => {
  fs.writeFileSync(`${tmp}/d.hlsl`, src)
  try { execFileSync('dxc', ['-T', 'ps_6_0', '-E', 'main', '-Fo', `${tmp}/d.dxil`, `${tmp}/d.hlsl`], { stdio: 'pipe' }); return 'ok' }
  catch (e: any) { bad++; return 'FAIL\n' + String(e.stderr).split('\n').slice(0, 6).join('\n') + '\n' }
}
const T: Record<string, string> = { float: 'float', vec3: 'float3', vec2: 'float2', vec4: 'float4' }
const PIN: Record<string, string> = { UV: 'float2', ObjPos: 'float3', ObjNrm: 'float3', WPos: 'float3', WNrm: 'float3', CamVec: 'float3', Time: 'float', LightDir: 'float4', LightColor: 'float4', VCol: 'float4', N: 'float3', P: 'float3', C: 'float3', SceneR: 'float4', SceneG: 'float4', SceneB: 'float4' }
const OUT: Record<string, string> = { CMOT_FLOAT1: 'float', CMOT_FLOAT2: 'float2', CMOT_FLOAT3: 'float3', CMOT_FLOAT4: 'float4' }

// Unreal pastes a Custom node's code as the body of a function whose arguments are the node's inputs, then its
// extra outputs as inout arguments. This builds the same function and calls it, so DXC compiles all of it.
function wrap(code: string, ins: [string, string][], ret: string, outs: [string, string][]) {
  const args = [...ins.map(([n, t]) => `${t} ${n}`), ...outs.map(([n, t]) => `inout ${t} ${n}`)]
  const call = [...ins.map(([n]) => 'in_' + n), ...outs.map(([n]) => 'out_' + n)]
  return `cbuffer C { ${ins.map(([n, t]) => `${t} in_${n};`).join(' ')} float pad_; };
${ret} CustomExpression0(${args.join(', ')}) {
${code}
}
float4 main() : SV_Target {
  ${outs.map(([n, t]) => `${t} out_${n} = (${t})0;`).join(' ')}
  ${ret} r = CustomExpression0(${call.join(', ')});
  return float4(${[`(float)r${ret === 'float' ? '' : '.x'}`, ...outs.map(([n, t]) => `(float)out_${n}${t === 'float' ? '' : '.x'}`)].join(' + ')}, 0, 0, 1);
}
`
}
const lit = (s: string) => JSON.parse(s)

const sources: [string, any][] = [
  ...fs.readdirSync('examples').map((f) => [f, JSON.parse(fs.readFileSync('examples/' + f, 'utf8'))] as [string, any]),
  ...fs.readdirSync('looks').map((f) => [f, parse(fs.readFileSync('looks/' + f, 'utf8'))] as [string, any]),
  ...fs.readdirSync('test/glsl').map((f) => [f, read(fs.readFileSync('test/glsl/' + f, 'utf8'), f).graph] as [string, any]),
  ...fs.readdirSync('test/hlsl').map((f) => [f, read(fs.readFileSync('test/hlsl/' + f, 'utf8'), f).graph] as [string, any]),
]
for (const [f, g] of sources) {
  const ir = check(g)
  const res: string[] = []
  res.push('unity ' + dxc(toUnity(ir) + `\nfloat4 main() : SV_Target { return 0; }\n`))
  // the single Custom node materials (Custom node, Material Function, Substrate)
  const forms = ir.lit ? [{}, { substrate: true }, { as: 'function' as const, substrate: true }] : [{}, { as: 'function' as const }]
  for (const o of forms) {
    const py = toUnreal(ir, o)
    const code = lit(py.match(/custom\.set_editor_property\("code", (".*")\)/)![1])
    const pins = [...py.matchAll(/pins\.append\(\("([^"]+)"/g)].map((m) => m[1])
    const block = py.split('custom.set_editor_property("additional_outputs", [')[1]?.split('])')[0] ?? ''
    const outs = [...block.matchAll(/custom_output\("([^"]+)", unreal\.CustomMaterialOutputType\.(\w+)\)/g)].map((m) => [m[1], OUT[m[2]]] as [string, string])
    const ins = pins.map((p) => [p, PIN[p] ?? (ir.params.find((q: any) => 'P_' + q.id === p)?.t === 'vec3' ? 'float4' : 'float')] as [string, string])
    const tag = `unreal${(o as any).as ? '-function' : ''}${(o as any).substrate ? '-substrate' : ''}`
    res.push(tag + ' ' + dxc(wrap(code, ins, 'float4', outs)))
  }
  // every Custom node in the native-node material
  const py = toUnrealNative(ir)
  const graph = unrealGraph(ir)
  let n = 0, fails = ''
  for (const m of py.matchAll(/^(\w+)\.set_editor_property\("code", (".*")\)$/gm)) {
    const node = graph.nodes.find((x: any) => x.id === m[1])
    const rest = py.slice(m.index!)
    const kind = rest.match(new RegExp(`^${m[1]}\\.set_editor_property\\("output_type", unreal\\.CustomMaterialOutputType\\.(\\w+)\\)`, 'm'))![1]
    const pinLine = rest.match(new RegExp(`^${m[1]}\\.set_editor_property\\("inputs", \\[(.*)\\]\\)$`, 'm'))?.[1] ?? ''
    // inputs are written either as custom_input("a"), ... or as custom_input(n) for n in ("a", ...)
    const pins = /for n in/.test(pinLine) ? [...pinLine.split('for n in')[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [...pinLine.matchAll(/custom_input\("([^"]+)"\)/g)].map((x) => x[1])
    const ports: [string, string][] = node?.ports?.ins ?? []
    const ins = pins.map((p) => [p, T[ports.find(([nm]) => nm === p)?.[1] ?? ''] ?? PIN[p] ?? 'float'] as [string, string])
    const outBlock = rest.match(new RegExp(`^${m[1]}\\.set_editor_property\\("additional_outputs", \\[(.*)\\]\\)$`, 'm'))?.[1] ?? ''
    const outs = [...outBlock.matchAll(/custom_output\("([^"]+)", unreal\.CustomMaterialOutputType\.(\w+)\)/g)].map((x) => [x[1], OUT[x[2]]] as [string, string])
    const r = dxc(wrap(lit(m[2]), ins, OUT[kind], outs))
    n++
    if (r !== 'ok') fails += `\n  node ${m[1]} (${node?.title}): ${r}`
  }
  res.push(`native ${n} custom nodes ${fails ? 'FAIL' + fails : 'ok'}`)
  console.log(f.padEnd(28), res.join(' | '))
}
console.log(bad ? `dxc: ${bad} failed` : 'dxc: all passed')
process.exit(bad ? 1 : 0)
