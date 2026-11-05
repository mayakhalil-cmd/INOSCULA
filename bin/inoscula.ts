#!/usr/bin/env node
// inoscula <shader file> [--to three,godot,unreal,unity,blender] [--out folder]
// A shader file is Inoscula code (.inoscula), a graph (.inoscula.json), or a GLSL or HLSL shader you already have:
// Shadertoy, The Book of Shaders, three.js, TouchDesigner, a Unity .shader, an Unreal Custom node (.glsl, .frag,
// .hlsl, .shader, .txt...).
import fs from 'node:fs'
import path from 'node:path'
import { check, read, styleName, InosculaError, toBlender, toGodot, toGodotOutline, toGodotVisual, toThree, toUnity, toUnityOutline, toUnityShader, toUnreal, toUnrealNative, GODOT_LIGHT_BRIDGE } from '../src/index.ts'

const args = process.argv.slice(2)
const opt = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d }
const to = opt('--to', 'three,godot,unreal,unity,blender').split(',')
const outDir = opt('--out', 'out')
if (!args.length) { console.log('usage: inoscula <shader file> [--to three,godot,unreal,unity,blender] [--out folder]\n  The shader file can be Inoscula code, a .inoscula.json graph, or GLSL or HLSL (Shadertoy, Unity, Unreal and more).'); process.exit(1) }

let failed = false
for (const raw of args) {
  // a path typed or dragged into a Windows prompt can arrive with quotes or a line break around it
  const file = raw.trim().replace(/^"(.*)"$/, '$1')
  try {
    const text = fs.readFileSync(file, 'utf8')
    let graph
    if (/\.json$/i.test(file)) graph = JSON.parse(text)
    else {
      const r = read(text)
      graph = r.graph
      if (r.language !== 'inoscula') console.log(`${file}: read as ${r.style ? styleName(r.style) : r.language.toUpperCase()}`)
      for (const w of r.warnings) console.log(`  note${w.line ? ` (line ${w.line})` : ''}: ${w.msg}`)
    }
    const ir = check(graph)
    const base = path.basename(file).replace(/\.inoscula\.json$|\.json$|\.inoscula$|\.(glsl|frag|fs|fsh|hlsl|shader|cginc|usf|ush|txt)$/i, '')
    const dir = path.join(outDir, base)
    fs.mkdirSync(dir, { recursive: true })
    const write = (name: string, text: string) => { fs.writeFileSync(path.join(dir, name), text); console.log('  ' + path.join(dir, name)) }
    console.log(`${ir.name}:`)
    for (const t of to) {
      if (t === 'three') { const s = toThree(ir); write(`${base}.three.json`, JSON.stringify(s, null, 2)) }
      else if (t === 'godot') {
        write(`${base}.gdshader`, toGodot(ir)); write('inoscula_light_bridge.gd', GODOT_LIGHT_BRIDGE)
        if (ir.outline) write(`${base}.outline.gdshader`, toGodotOutline(ir))
        // the node version cannot hold everything yet (glass); the shader code version still works
        try { write(`${base}.tres`, toGodotVisual(ir)) } catch (e) { if (!(e instanceof InosculaError)) throw e; console.log(`  (no .tres: ${e.message.replace(/ Pick Shader code\.$/, ' Use the .gdshader.')})`) }
      }
      else if (t === 'unreal') { write(`${base}.unreal.py`, toUnrealNative(ir)); write(`${base}.unreal-custom.py`, toUnreal(ir)) }
      // the .shader is the one to use: drop it in Assets and make a material. The .hlsl is for Shader Graph.
      else if (t === 'unity') { write(`${base}.shader`, toUnityShader(ir)); write(`${base}.unity.hlsl`, toUnity(ir)); if (ir.outline) write(`${base}.outline.shader`, toUnityOutline(ir)) }
      else if (t === 'blender') write(`${base}.blender.py`, toBlender(ir))
      else throw new InosculaError(`Unknown target "${t}".`)
    }
  } catch (e) {
    failed = true
    console.error(`${file}: ${e instanceof InosculaError ? e.message : (e as Error).stack}`)
  }
}
process.exit(failed ? 1 : 0)
