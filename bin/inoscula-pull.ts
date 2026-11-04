#!/usr/bin/env node
// Godot -> Inoscula. Reads a ShaderMaterial saved by Godot (.tres or a scene .tscn) together with the Inoscula
// .gdshader it uses, and writes the graph with every parameter as you set it in Godot's Inspector.
//   node bin/inoscula-pull.ts <material.tres|scene.tscn> <shader.gdshader> [out.inoscula.json]
import fs from 'node:fs'

const [matFile, shaderFile, out] = process.argv.slice(2)
if (!matFile || !shaderFile) { console.log('usage: inoscula-pull <material.tres|scene.tscn> <shader.gdshader> [out.inoscula.json]'); process.exit(1) }
const line = fs.readFileSync(shaderFile, 'utf8').split('\n').find((l) => l.startsWith('// inoscula-graph: '))
if (!line) { console.error(`${shaderFile} was not made by Inoscula (no inoscula-graph line).`); process.exit(1) }
const graph = JSON.parse(line.slice('// inoscula-graph: '.length))
const text = fs.readFileSync(matFile, 'utf8')
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
let n = 0
for (const p of graph.params ?? []) {
  const m = new RegExp(`shader_parameter/p_${p.id}\\s*=\\s*(.+)`).exec(text)
  if (!m) continue
  const v = m[1].trim()
  const nums = (v.match(/-?[\d.]+(e-?\d+)?/g) ?? []).map(Number)
  if (p.type === 'float' && nums.length) p.default = nums[0]
  else if (nums.length >= 3) p.default = p.type === 'color' ? nums.slice(0, 3).map(lin) : nums.slice(0, 3) // Godot stores colours as sRGB
  n++
}
const dest = out ?? matFile.replace(/\.(tres|tscn)$/, '') + '.inoscula.json'
fs.writeFileSync(dest, JSON.stringify(graph, null, 2))
console.log(`Inoscula: read ${n} parameter${n === 1 ? '' : 's'} from Godot, wrote ${dest}`)
