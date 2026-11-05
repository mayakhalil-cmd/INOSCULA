// One way in for any shader text: Inoscula code, GLSL from Shadertoy, The Book of Shaders, three.js,
// TouchDesigner, ISF or anywhere else, or HLSL (plain, Unity or an Unreal Custom node). The reader is picked
// from what the text looks like; if that reader cannot follow it, another one tries, and the error shown is
// the one from the reader that fits best.
import type { Graph } from './spec.ts'
import { parse } from './lang.ts'
import { readGLSL, looksLikeGLSL, type Style } from './glsl/index.ts'
import { looksLikeHLSL, hlslToGLSL } from './glsl/hlsl.ts'

export interface Reading { graph: Graph; language: 'inoscula' | 'glsl' | 'hlsl'; style?: Style; warnings: { line: number; msg: string }[] }

export function read(text: string, name?: string): Reading {
  const glsl = (): Reading => { const r = readGLSL(text, name ?? findName(text)); return { graph: r.graph, language: 'glsl', style: r.style, warnings: r.warnings } }
  const ino = (): Reading => { const g = parse(text); if (name) g.name = name; return { graph: g, language: 'inoscula', warnings: [] } }
  const hlsl = (): Reading => {
    const h = hlslToGLSL(text)
    const r = readGLSL(h.glsl, name ?? findName(text), { style: h.kind, macros: h.macros, linear: h.kind !== 'hlsl' })
    const last = text.split('\n').length
    // anything said about the lines added below the shader belongs to the pixel function
    const warnings = [...h.warnings, ...r.warnings].map((w) => (w.line > last ? { ...w, line: 0 } : w))
    return { graph: r.graph, language: 'hlsl', style: r.style, warnings }
  }
  if (looksLikeHLSL(text)) {
    try { return hlsl() } catch (e1) {
      try { return glsl() } catch { throw e1 }
    }
  }
  const [first, second] = looksLikeGLSL(text) && !/^\s*name\s+"/m.test(text) ? [glsl, ino] : [ino, glsl]
  try { return first() } catch (e1) {
    try { return second() } catch { throw e1 }
  }
}

// a name from the comments at the very top, such as "// Ocean Waves" or "/* Name: Ocean Waves */". Comments
// after the first line of code describe the code, not the shader, so they are never used.
function findName(text: string): string {
  const unity = /^\s*Shader\s*"([^"]+)"/m.exec(text)
  if (unity) return unity[1].split('/').pop()!.trim() || 'Untitled'
  const top: string[] = []
  let block = false
  for (const raw of text.split('\n')) {
    let line = raw.trim()
    if (block) {
      const end = line.indexOf('*/')
      top.push(line.slice(0, end < 0 ? undefined : end))
      if (end >= 0) block = false
      continue
    }
    if (!line || /^(#\s*(version|extension|ifdef|ifndef|if|endif|else)\b|precision\s)/.test(line)) continue
    if (line.startsWith('//')) { top.push(line.slice(2)); continue }
    if (line.startsWith('/*')) {
      line = line.slice(2)
      const end = line.indexOf('*/')
      top.push(line.slice(0, end < 0 ? undefined : end))
      block = end < 0
      continue
    }
    break
  }
  for (const c of top) {
    let n = c.replace(/^[\s*=#-]+/, '').replace(/^(name|title|shader)\s*:\s*/i, '').replace(/\s+(by|-|–)\s.*$/i, '').replace(/[\s.:*=-]+$/, '').trim()
    if (n.length > 48) n = n.split(/[,;(]|\s-\s/)[0].trim()
    if (n.length < 2 || n.length > 48 || !/^[A-Za-z]/.test(n)) continue
    if (/^(https?|www\.|copyright|license|licence|created|author|made|paste|shadertoy|precision|version|spdx)/i.test(n)) continue
    return n
  }
  return 'Untitled'
}
