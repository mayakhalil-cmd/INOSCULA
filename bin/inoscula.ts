#!/usr/bin/env node
// inoscula <shader.inoscula.json> [--to three,godot,unreal,unity,blender] [--out folder]
import fs from 'node:fs'
import path from 'node:path'
import { check, InosculaError, toBlender, toGodot, toThree, toUnity, toUnreal, GODOT_LIGHT_BRIDGE } from '../src/index.ts'

const args = process.argv.slice(2)
const opt = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d }
const to = opt('--to', 'three,godot,unreal,unity,blender').split(',')
const outDir = opt('--out', 'out')
if (!args.length) { console.log('usage: inoscula <shader.inoscula.json> [--to three,godot,unreal,unity,blender] [--out folder]'); process.exit(1) }

let failed = false
for (const file of args) {
  try {
    const ir = check(JSON.parse(fs.readFileSync(file, 'utf8')))
    const base = path.basename(file).replace(/\.inoscula\.json$|\.json$/, '')
    const dir = path.join(outDir, base)
    fs.mkdirSync(dir, { recursive: true })
    const write = (name: string, text: string) => { fs.writeFileSync(path.join(dir, name), text); console.log('  ' + path.join(dir, name)) }
    console.log(`${ir.name}:`)
    for (const t of to) {
      if (t === 'three') { const s = toThree(ir); write(`${base}.three.json`, JSON.stringify(s, null, 2)) }
      else if (t === 'godot') { write(`${base}.gdshader`, toGodot(ir)); write('inoscula_light_bridge.gd', GODOT_LIGHT_BRIDGE) }
      else if (t === 'unreal') write(`${base}.unreal.py`, toUnreal(ir))
      else if (t === 'unity') write(`${base}.unity.hlsl`, toUnity(ir))
      else if (t === 'blender') write(`${base}.blender.py`, toBlender(ir))
      else throw new InosculaError(`Unknown target "${t}".`)
    }
  } catch (e) {
    failed = true
    console.error(`${file}: ${e instanceof InosculaError ? e.message : (e as Error).stack}`)
  }
}
process.exit(failed ? 1 : 0)
