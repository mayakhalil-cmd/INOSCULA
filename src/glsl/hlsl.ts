// HLSL in, GLSL out, for the GLSL reader to take from there. Covers plain HLSL pixel shaders, Unity .shader
// files (the CGPROGRAM / HLSLPROGRAM part, with the Properties block turned into slider notes) and the code
// of an Unreal Custom node. Every line stays on the line it was on, so messages point at the right place;
// what HLSL needs on top (helper functions, the call into the pixel function) goes after the last line.
import { CodeError } from '../lang.ts'

export type HLSLKind = 'hlsl' | 'unity' | 'unreal'
export interface HLSLResult { glsl: string; kind: HLSLKind; macros: Record<string, string>; warnings: { line: number; msg: string }[] }

/** Does this text look like HLSL (or Unity / Unreal shader code) rather than GLSL? */
export function looksLikeHLSL(src: string): boolean {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  if (/\bShader\s*"[^"]*"\s*\{/.test(code) && /\b(CGPROGRAM|HLSLPROGRAM)\b/.test(code)) return true
  const hl = (code.match(/\b((float|half|fixed|min16float|int|uint|bool)[234](x[234])?|SV_Target\d?|SV_POSITION|TEXCOORD\d|lerp|saturate|frac|tex2D|cbuffer|Texture2D|SamplerState)\b/gi) ?? []).length
  const gl = (code.match(/\b(vec[234]|ivec[234]|mat[234]|gl_\w+|mainImage|texture2D|uniform\s+sampler2D|fract|mix)\b/g) ?? []).length
  return hl > 0 && hl > gl
}

const TYPES: Record<string, string> = {}
for (const [h, g] of [['float', ''], ['half', ''], ['fixed', ''], ['min16float', ''], ['min10float', ''], ['double', ''], ['int', 'i'], ['min16int', 'i'], ['uint', 'u'], ['min16uint', 'u'], ['dword', 'u'], ['bool', 'b']]) {
  const scalar = g === '' ? 'float' : g === 'i' ? 'int' : g === 'u' ? 'uint' : 'bool'
  TYPES[h] = scalar
  for (const n of [1, 2, 3, 4]) TYPES[h + n] = n === 1 ? scalar : g + 'vec' + n
  if (g === '') for (const r of [2, 3, 4]) for (const c of [2, 3, 4]) TYPES[`${h}${r}x${c}`] = r === c ? `mat${r}` : `mat${c}x${r}`
}
Object.assign(TYPES, { Texture2D: 'sampler2D', Texture3D: 'sampler3D', TextureCube: 'samplerCube', Texture2DArray: 'sampler2D', SamplerState: 'sampler2D', SamplerComparisonState: 'sampler2D', sampler: 'sampler2D', sampler2D_float: 'sampler2D', sampler2D_half: 'sampler2D' })

// HLSL functions with another name in GLSL, or that need a small helper (written out below the shader)
const RENAME: Record<string, string> = {
  lerp: 'mix', frac: 'fract', rsqrt: 'inversesqrt', atan2: 'atan', ddx: 'dFdx', ddy: 'dFdy', ddx_fine: 'dFdx', ddy_fine: 'dFdy',
  ddx_coarse: 'dFdx', ddy_coarse: 'dFdy', 
  texCUBE: 'texture', texCUBElod: 'texture', tex3D: 'texture', tex3Dlod: 'texture', asfloat: 'uintBitsToFloat', asuint: 'floatBitsToUint',
  asint: 'floatBitsToInt', countbits: 'bitCount', firstbithigh: 'findMSB', firstbitlow: 'findLSB', reversebits: 'bitfieldReverse',
  saturate: '_hl_saturate', fmod: '_hl_fmod', mad: '_hl_mad', rcp: '_hl_rcp', log10: '_hl_log10', exp10: '_hl_exp10', mul: '_hl_mul',
  sincos: '_hl_sincos', clip: '_hl_clip', any: '_hl_any', all: '_hl_all', radians: 'radians', degrees: 'degrees', fma: '_hl_mad',
}
const SAMPLE_METHODS = new Set(['Sample', 'SampleLevel', 'SampleBias', 'SampleGrad', 'SampleCmp', 'SampleCmpLevelZero', 'Load', 'Gather', 'GetDimensions'])
const ATTRIBUTES = new Set(['unroll', 'loop', 'branch', 'flatten', 'fastopt', 'allow_uav_condition', 'forcecase', 'call', 'numthreads', 'earlydepthstencil', 'maxvertexcount', 'domain', 'partitioning', 'outputtopology', 'outputcontrolpoints', 'patchconstantfunc', 'instance'])
const DROP = new Set(['static', 'inline', 'precise', 'nointerpolation', 'noperspective', 'groupshared', 'row_major', 'column_major', 'extern', 'volatile', 'globallycoherent'])
// words that are only modifiers when a type follows (they can also be ordinary names)
const MODIFIERS = new Set(['linear', 'centroid', 'sample', 'snorm', 'unorm'])
const SEMANTIC = /^(SV_\w+|TEXCOORD\d*|COLOR\d*|POSITION\d*|POSITIONT|NORMAL\d*|TANGENT\d*|BINORMAL\d*|VPOS|VFACE|FACE|DEPTH\d*|PSIZE\d*|BLENDWEIGHT\d*|BLENDINDICES\d*|FOG|register|packoffset)$/i

// Unity's built-in macros a fragment shader can meet, made harmless
const UNITY_MACROS: Record<string, string> = {
  'UNITY_FOG_COORDS(x)': '', 'UNITY_TRANSFER_FOG(a,b)': '', 'UNITY_APPLY_FOG(a,b)': '', 'UNITY_APPLY_FOG_COLOR(a,b,c)': '',
  'UNITY_VERTEX_INPUT_INSTANCE_ID': '', 'UNITY_VERTEX_OUTPUT_STEREO': '', 'UNITY_SETUP_INSTANCE_ID(x)': '', 'UNITY_TRANSFER_INSTANCE_ID(a,b)': '',
  'UNITY_INITIALIZE_OUTPUT(t,x)': '', 'UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(x)': '', 'UNITY_SETUP_STEREO_EYE_INDEX_POST_VERTEX(x)': '',
  'TRANSFORM_TEX(uv,name)': '(uv)', 'UNITY_DECLARE_TEX2D(name)': 'uniform sampler2D name', 'UNITY_SAMPLE_TEX2D(name,uv)': 'texture(name, uv)',
  'TEXTURE2D(name)': 'uniform sampler2D name', 'SAMPLER(name)': 'uniform sampler2D name', 'SAMPLE_TEXTURE2D(t,s,uv)': 'texture(t, uv)',
  'CBUFFER_START(name)': '', 'CBUFFER_END': '', 'UNITY_PI': '3.14159265359', 'UNITY_TWO_PI': '6.28318530718', 'UNITY_FOUR_PI': '12.5663706144',
  'UNITY_INV_PI': '0.31830988618', 'UNITY_INV_TWO_PI': '0.15915494309', 'UNITY_HALF_PI': '1.57079632679', 'PI': '3.14159265359',
  'UNITY_LIGHTING_COORDS(a,b)': '', 'LIGHTING_COORDS(a,b)': '', 'SHADOW_COORDS(x)': '', 'TRANSFER_SHADOW(x)': '', 'UNITY_SHADOW_COORDS(x)': '',
}
// Unreal Custom node inputs that have an Inoscula meaning; anything else becomes a slider
const UNREAL_INPUTS: Record<string, string> = {
  UV: 'vUv', UVs: 'vUv', TexCoord: 'vUv', TexCoords: 'vUv', Coords: 'vUv', Coord: 'vUv', uv: 'vUv', UV0: 'vUv',
  Time: 'iTime', time: 'iTime', T: 'iTime', GameTime: 'iTime',
  WorldPosition: 'world_pos', WorldPos: 'world_pos', AbsoluteWorldPosition: 'world_pos', Position: 'world_pos', Pos: 'world_pos',
  ObjectPosition: 'object_pos', LocalPosition: 'object_pos',
  Normal: 'normal', WorldNormal: 'normal', VertexNormal: 'normal', N: 'normal', CameraVector: 'view_dir', ViewDir: 'view_dir',
}

type Tk = { k: 'id' | 'num' | 'op' | 'ws' | 'str'; v: string }
function hlslTokens(src: string): Tk[] {
  const out: Tk[] = []
  const re = /(\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*")|([A-Za-z_]\w*)|((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fFhHlLuU]*|0[xX][0-9a-fA-F]+[uUlL]*)|(<<=|>>=|\+\+|--|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|==|!=|<=|>=|&&|\|\||<<|>>|::|.)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (m[1] !== undefined) out.push({ k: 'ws', v: m[1] })
    else if (m[2] !== undefined) out.push({ k: 'str', v: m[2] })
    else if (m[3] !== undefined) out.push({ k: 'id', v: m[3] })
    else if (m[4] !== undefined) out.push({ k: 'num', v: m[4] })
    else out.push({ k: 'op', v: m[5] })
  }
  return out
}
const lines = (s: string) => (s.match(/\n/g) ?? []).length

export function hlslToGLSL(input: string): HLSLResult {
  let src = input.replace(/\r\n?/g, '\n')
  const warnings: HLSLResult['warnings'] = []
  const macros: Record<string, string> = {}
  let kind: HLSLKind = 'hlsl'
  let entryName: string | undefined

  // ---- Unity: keep only the shader program, with the Properties as slider notes on their uniforms
  const isUnity = /\bShader\s*"[^"]*"\s*\{/.test(src) && /\b(CGPROGRAM|HLSLPROGRAM)\b/.test(src)
  const props = new Map<string, { note: string; vals: number[] }>()
  if (isUnity) {
    kind = 'unity'
    Object.assign(macros, UNITY_MACROS)
    const pm = /\bProperties\s*\{/.exec(src)
    if (pm) {
      let depth = 0, end = pm.index + pm[0].length - 1
      for (let i = end; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) { end = i; break } }
      const body = src.slice(pm.index, end)
      const re = /^\s*(?:\[[^\]]*\]\s*)*(\w+)\s*\(\s*"([^"]*)"\s*,\s*(\w+)\s*(?:\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\))?\s*\)\s*=\s*(.*)$/gm
      let m: RegExpExecArray | null
      while ((m = re.exec(body))) {
        const [, name, label, type, lo, hi, dflt] = m
        let note = `@label ${label}`
        const t = type.toLowerCase()
        if (t === 'range' && lo !== undefined) note += ` @range ${parseFloat(lo)} ${parseFloat(hi)}`
        if (t === 'int' || t === 'integer') note += ' @step 1'
        if (t === 'color') note += ' @color'
        const tuple = /^\(\s*([^)]*)\)/.exec(dflt.trim())
        const num = /^(-?[\d.]+)/.exec(dflt.trim())
        let vals = tuple ? tuple[1].split(',').map((x) => parseFloat(x) || 0) : num ? [parseFloat(num[1])] : []
        // Unity hands Color properties to the shader as linear color (in its default linear mode); alpha stays
        if (t === 'color' && !/\[\s*HDR\s*\]/.test(m[0])) vals = vals.map((x, k) => (k < 3 ? (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)) : x))
        props.set(name, { note, vals })
      }
    }
    // the first pass's program, plus any CGINCLUDE / HLSLINCLUDE blocks; everything else becomes blank lines
    const keep: [number, number][] = []
    const blocks = [...src.matchAll(/\b(CGPROGRAM|HLSLPROGRAM|CGINCLUDE|HLSLINCLUDE)\b([\s\S]*?)\b(ENDCG|ENDHLSL)\b/g)]
    let programs = 0
    for (const b of blocks) {
      if (/PROGRAM/.test(b[1])) { if (programs++) continue }
      const start = b.index! + b[1].length
      keep.push([start, start + b[2].length])
    }
    let out = ''
    let at = 0
    for (const [s, e] of keep) { out += src.slice(at, s).replace(/[^\n]/g, ' ') + src.slice(s, e); at = e }
    out += src.slice(at).replace(/[^\n]/g, ' ')
    src = out
    entryName = /#\s*pragma\s+fragment\s+(\w+)/.exec(src)?.[1]
  }

  // includes: Unity's and the render pipelines' own files are known; anything else must be pasted in
  src = src.replace(/^[ \t]*#\s*include\s*[<"]([^>"]*)[>"].*$/gm, (line, file: string) => {
    if (/Unity|\.cginc$|Packages\/com\.unity|Core\.hlsl|Common\.hlsl|Lighting\.hlsl|^\/Engine\//i.test(file)) return line.replace(/[^\n]/g, ' ')
    return line
  })
  // #pragma lines and Unity's #pragma multi_compile mean nothing to nodes
  src = src.replace(/^[ \t]*#\s*pragma\b.*$/gm, (l) => l.replace(/[^\n]/g, ' '))
  // the constant-buffer markers carry no semicolon, so they go before the declarations are read
  src = src.replace(/\b(?:CBUFFER_START|UNITY_INSTANCING_BUFFER_START|UNITY_INSTANCING_BUFFER_END)\s*\(\s*\w*\s*\)|\bCBUFFER_END\b/g, (c) => c.replace(/[^\n]/g, ' '))
  // the structs UnityCG.cginc declares, written on the first line so line numbers stay the same
  const BUILTIN: Record<string, string> = {
    v2f_img: 'struct v2f_img { float4 pos : SV_POSITION; half2 uv : TEXCOORD0; };',
    appdata_img: 'struct appdata_img { float4 vertex : POSITION; half2 texcoord : TEXCOORD0; };',
    appdata_base: 'struct appdata_base { float4 vertex : POSITION; float3 normal : NORMAL; float4 texcoord : TEXCOORD0; };',
    appdata_full: 'struct appdata_full { float4 vertex : POSITION; float4 tangent : TANGENT; float3 normal : NORMAL; float4 texcoord : TEXCOORD0; float4 color : COLOR; };',
  }
  const extra = Object.keys(BUILTIN).filter((n) => new RegExp('\\b' + n + '\\b').test(src) && !new RegExp('\\bstruct\\s+' + n + '\\b').test(src)).map((n) => BUILTIN[n]).join(' ')
  if (extra) src = extra + ' ' + src

  // ---- what the inputs and outputs of each struct and function are, from their semantics
  const code = src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '')
  type Field = { type: string; name: string; sem?: string }
  const structs = new Map<string, Field[]>()
  for (const m of code.matchAll(/\bstruct\s+(\w+)\s*\{([^}]*)\}/g)) {
    const fields: Field[] = []
    for (const f of m[2].matchAll(/(?:\b(?:nointerpolation|linear|centroid|noperspective|sample)\s+)*\b(\w+)\s+(\w+)\s*(?:\[[^\]]*\])?\s*(?::\s*(\w+))?\s*;/g)) fields.push({ type: f[1], name: f[2], sem: f[3] })
    structs.set(m[1], fields)
  }
  type FnSig = { ret: string; name: string; params: (Field & { q: string })[]; sem?: string; at: number }
  const fns: FnSig[] = []
  for (const m of code.matchAll(/\b(\w+)\s+(\w+)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?::\s*(\w+))?\s*\{/g)) {
    if (['if', 'for', 'while', 'switch', 'return', 'else'].includes(m[2]) || ['return', 'else', 'new'].includes(m[1])) continue
    const params = m[3].split(',').map((p) => p.trim()).filter((p) => p && p !== 'void').map((p) => {
      const pm = /^((?:(?:in|out|inout|uniform|const|nointerpolation|linear|centroid|noperspective)\s+)*)(\w+)\s+(\w+)\s*(?:\[[^\]]*\])?\s*(?::\s*(\w+))?/.exec(p)
      return pm ? { q: pm[1].trim(), type: pm[2], name: pm[3], sem: pm[4] } : { q: '', type: '', name: '' }
    })
    fns.push({ ret: m[1], name: m[2], params, sem: m[4], at: m.index! })
  }

  // an Unreal Custom node holds only the inside of a function
  const isCustom = fns.length === 0 && /\breturn\b/.test(code)

  // ---- token by token
  const t = hlslTokens(src)
  const sig = (i: number, dir: 1 | -1) => { for (let j = i + dir; j >= 0 && j < t.length; j += dir) if (t[j].k !== 'ws') return j; return -1 }
  const userFns = new Set(fns.map((f) => f.name))
  const userTypes = new Set(structs.keys())
  const isType = (v: string) => v in TYPES || userTypes.has(v) || /^(vec|ivec|uvec|bvec|mat)[234]$/.test(v) || v === 'float' || v === 'int' || v === 'uint' || v === 'bool' || v === 'void'
  let depth = 0
  const cbufferClose: number[] = []
  for (let i = 0; i < t.length; i++) {
    const tk = t[i]
    if (tk.k === 'op') {
      if (tk.v === '{') depth++
      else if (tk.v === '}') {
        if (cbufferClose.length && depth === cbufferClose[cbufferClose.length - 1]) {
          // the end of a cbuffer: its opening brace was dropped too, so the depth does not change
          cbufferClose.pop()
          tk.v = ''
          const n = sig(i, 1); if (n >= 0 && t[n].v === ';') t[n].v = ''
        } else depth--
      } else if (tk.v === ':') {
        // a semantic after a parameter, a field or a function: drop it, with register(...) / packoffset(...)
        const n = sig(i, 1)
        if (n >= 0 && t[n].k === 'id' && SEMANTIC.test(t[n].v)) {
          const p = sig(i, -1)
          const after = sig(n, 1)
          const declCtx = p >= 0 && (t[p].k === 'id' || t[p].v === ')' || t[p].v === ']')
          if (declCtx && (after < 0 || [',', ')', ';', '{', '(', ':', '='].includes(t[after].v))) {
            tk.v = ''; t[n].v = ''
            if (after >= 0 && t[after].v === '(') {
              let d = 0
              for (let j = after; j < t.length; j++) { if (t[j].v === '(') d++; if (t[j].v === ')') d--; const end = d === 0; t[j].v = ''; if (end) break }
            }
          }
        }
      } else if (tk.v === '[') {
        // [unroll], [loop], [numthreads(8,8,1)] and the like
        const n = sig(i, 1)
        if (n >= 0 && t[n].k === 'id' && ATTRIBUTES.has(t[n].v)) {
          let d = 0
          for (let j = i; j < t.length; j++) { if (t[j].v === '[') d++; if (t[j].v === ']') d--; const end = d === 0; t[j].v = ''; if (end) break }
        }
      } else if (tk.v === '(') {
        // a C cast: (float3)x, (int)(a / b), (MyStruct)0
        const a = sig(i, 1), b = a >= 0 ? sig(a, 1) : -1, c = b >= 0 ? sig(b, 1) : -1
        const prev = sig(i, -1)
        const callBefore = prev >= 0 && (t[prev].k === 'id' && !['return', 'case'].includes(t[prev].v) || t[prev].v === ')' || t[prev].v === ']')
        if (!callBefore && a >= 0 && t[a].k === 'id' && isType(t[a].v) && b >= 0 && t[b].v === ')' && c >= 0 && (t[c].k === 'id' || t[c].k === 'num' || t[c].v === '(' || t[c].v === '-' || t[c].v === '+' || t[c].v === '!')) {
          if (userTypes.has(t[a].v) && t[c].k === 'num' && /^0+(\.0*)?[fFhH]?$/.test(t[c].v)) {
            // (MyStruct)0: everything zero, which is what a declaration without a value already gives
            const eq = sig(i, -1)
            if (eq >= 0 && t[eq].v === '=') t[eq].v = ''
            tk.v = ''; t[a].v = ''; t[b].v = ''; t[c].v = ''
            continue
          }
          // find where the operand ends: a number, or a name with its calls, indexes and members, or a bracket
          let e = c
          const skip = (j: number) => { let d = 0; for (let k = j; k < t.length; k++) { if (t[k].v === '(' || t[k].v === '[') d++; if (t[k].v === ')' || t[k].v === ']') d--; if (d === 0) return k } return t.length - 1 }
          while (t[e].v === '-' || t[e].v === '+' || t[e].v === '!') e = sig(e, 1)
          if (t[e].v === '(') e = skip(e)
          for (;;) {
            const n = sig(e, 1)
            if (n < 0) break
            if (t[n].v === '(' || t[n].v === '[') { e = skip(n); continue }
            if (t[n].v === '.') { const m = sig(n, 1); if (m >= 0 && t[m].k === 'id') { e = m; continue } }
            break
          }
          const type = t[a].v
          tk.v = ''; t[b].v = ''
          t[a].v = (TYPES[type] ?? type) + '('
          t[e].v = t[e].v + ')'
          t[a].k = 'op' // already rewritten: the loop must not map it again
          continue
        }
      }
      continue
    }
    if (tk.k === 'num') {
      // 1.0h, 2L: suffixes GLSL does not have
      tk.v = tk.v.replace(/^(\d[\d.]*(?:[eE][+-]?\d+)?)[hHlL]$/, '$1').replace(/^(0[xX][0-9a-fA-F]+)[lL]$/, '$1')
      continue
    }
    if (tk.k !== 'id') continue
    const v = tk.v
    if (v === 'cbuffer' || v === 'tbuffer') {
      // cbuffer Name : register(b0) { ... }; the fields inside are plain uniforms
      let j = i
      for (; j < t.length && t[j].v !== '{'; j++) t[j].v = ''
      if (j < t.length) { t[j].v = ''; cbufferClose.push(depth) }
      continue
    }
    if (DROP.has(v) || (MODIFIERS.has(v) && (() => { const n = sig(i, 1); return n >= 0 && t[n].k === 'id' && (isType(t[n].v) || DROP.has(t[n].v) || MODIFIERS.has(t[n].v)) })())) {
      tk.v = ''; const n = i + 1; if (n < t.length && t[n].k === 'ws' && !t[n].v.includes('\n')) t[n].v = ''
      continue
    }
    if (v === 'Texture2D' || v === 'Texture3D' || v === 'TextureCube' || v === 'Texture2DArray' || v === 'RWTexture2D') {
      // Texture2D<float4> tex: the part in angle brackets goes
      const n = sig(i, 1)
      if (n >= 0 && t[n].v === '<') { for (let j = n; j < t.length; j++) { const end = t[j].v === '>'; t[j].v = ''; if (end) break } }
    }
    // tex.Sample(sampler, uv) and friends: reads a picture, which the reader explains
    if (SAMPLE_METHODS.has(v)) {
      const dot = sig(i, -1), obj = dot >= 0 ? sig(dot, -1) : -1, open = sig(i, 1)
      if (dot >= 0 && t[dot].v === '.' && obj >= 0 && t[obj].k === 'id' && open >= 0 && t[open].v === '(') {
        const objName = t[obj].v
        t[obj].v = 'texture'; t[dot].v = ''; tk.v = ''
        t[open].v = `(${objName},`
        continue
      }
    }
    const prev = sig(i, -1)
    const member = prev >= 0 && t[prev].v === '.'
    if (member) continue
    if (v in TYPES && !userTypes.has(v)) { tk.v = TYPES[v]; continue }
    if (v in RENAME && !userFns.has(v)) {
      const n = sig(i, 1)
      if (n >= 0 && t[n].v === '(') tk.v = RENAME[v]
      continue
    }
  }

  // globals: in HLSL a variable outside any function is a uniform, unless it is const or static
  const t2 = t.filter((x) => x.v !== '')
  const staticNames = new Set<string>()
  for (const m of code.matchAll(/\bstatic\s+(?:const\s+)?\w+\s+(\w+)/g)) staticNames.add(m[1])
  const fixed: Tk[] = []
  depth = 0
  let stmtStart = true
  const next = (i: number) => { let j = i + 1; while (j < t2.length && t2[j].k === 'ws') j++; return j }
  for (let i = 0; i < t2.length; i++) {
    const x = t2[i]
    if (x.k === 'ws') { fixed.push(x); continue }
    if (!isCustom && depth === 0 && stmtStart && x.k === 'id' && isType(x.v) && x.v !== 'void') {
      // TYPE NAME followed by ; = [ or , is a global variable (TYPE NAME ( is a function)
      const n = next(i), a = next(n)
      if (t2[n]?.k === 'id' && [';', '=', '[', ','].includes(t2[a]?.v) && !staticNames.has(t2[n].v)) fixed.push({ k: 'id', v: 'uniform ' })
    }
    if (x.v === '{') depth++
    if (x.v === '}') depth--
    stmtStart = x.v === ';' || x.v === '{' || x.v === '}'
    fixed.push(x)
  }
  let glsl = fixed.map((x) => x.v).join('')

  // the Properties notes go onto the line that declares each uniform
  if (props.size) {
    glsl = glsl.split('\n').map((l) => {
      const m = /^(\s*uniform\s+(\w+)\s+(\w+)\s*);(.*)$/.exec(l)
      const p = m && props.get(m[3])
      if (!m || !p) return l
      // the starting value from Properties, written in the declaration where the reader takes it from
      const n = /^[biu]?vec(\d)$/.exec(m[2])?.[1]
      const f = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x))
      const init = !p.vals.length ? '' : n ? ` = ${m[2]}(${Array.from({ length: +n }, (_, k) => f(p.vals[k] ?? (k === 3 ? 1 : p.vals[0]))).join(', ')})` : m[2] === 'float' ? ` = ${f(p.vals[0])}` : m[2] === 'int' ? ` = ${Math.round(p.vals[0])}` : ''
      return `${m[1]}${init};${m[4]} // ${p.note}`
    }).join('\n')
  }

  // ---- the Unreal Custom node: only the inside of a function, reading inputs by name
  const tail: string[] = []
  if (isCustom) {
    kind = 'unreal'
    const declared = new Set<string>()
    for (const m of code.matchAll(/\b(?:float|half|int|uint|bool)(?:[234](?:x[234])?)?\s+(\w+)/g)) declared.add(m[1])
    for (const m of code.matchAll(/\bfor\s*\(\s*\w+\s+(\w+)/g)) declared.add(m[1])
    const inputs = new Map<string, number>()
    const KNOWN = /^(return|if|else|for|while|do|break|continue|switch|case|default|discard|true|false|const|static|in|out|inout|struct|uniform)$/
    for (const m of code.matchAll(/(?<![.\w])([A-Za-z_]\w*)\b(\s*\.\s*[xyzwrgba]+\b)?(\s*\()?/g)) {
      const [, n, sw, call] = m
      if (call || declared.has(n) || KNOWN.test(n) || n in TYPES || n in RENAME || /^(vec|ivec|uvec|bvec|mat)[234]$/.test(n)) continue
      if (n in UNREAL_INPUTS) { macros[n] = UNREAL_INPUTS[n]; continue }
      const want = sw ? Math.max(2, ...[...sw.replace(/[\s.]/g, '')].map((c) => 'xrygzbwa'.indexOf(c) >> 1)) + 1 : 1
      inputs.set(n, Math.max(inputs.get(n) ?? 1, want))
    }
    for (const [n, size] of inputs) {
      const ty = size === 1 ? 'float' : 'vec' + Math.max(2, size)
      const v = /speed|scale|zoom|intensity|strength|brightness|amount|size|density|freq|amp|contrast|gain|opacity|exposure|multiplier|factor|power|colou?r|tint/i.test(n) ? '1.0' : '0.0'
      tail.push(`uniform ${ty} ${n} = ${size === 1 ? v : `${ty}(${v})`};`)
    }
    if (inputs.size) warnings.push({ line: 1, msg: `${[...inputs.keys()].join(', ')} ${inputs.size === 1 ? 'is an input' : 'are inputs'} of the Custom node, so ${inputs.size === 1 ? 'it becomes a slider' : 'they become sliders'}. UV, Time, WorldPosition and Normal are filled in for you.` })
    const ret = /\breturn\s+(float|half)([234])\s*\(/.exec(code)
    const n = ret ? +ret[2] : 3
    const rt = n === 1 ? 'float' : 'vec' + n
    glsl = `${rt} _hl_custom() { ` + glsl + '\n}'
    tail.push(`void main() { gl_FragColor = ${n === 4 ? '_hl_custom()' : n === 1 ? 'vec4(vec3(_hl_custom()), 1.0)' : n === 2 ? 'vec4(_hl_custom(), 0.0, 1.0)' : 'vec4(_hl_custom(), 1.0)'}; }`)
  } else if (!fns.some((f) => f.name === 'mainImage') && !fns.some((f) => f.name === 'main' && f.params.length === 0 && f.ret === 'void')) {
    // ---- the pixel function and a main() that calls it
    const byName = entryName ? fns.find((f) => f.name === entryName) : undefined
    const entry = byName
      ?? fns.find((f) => f.sem && /^(SV_Target\d?|COLOR\d?)$/i.test(f.sem))
      ?? fns.find((f) => f.params.some((p) => p.q.includes('out') && p.sem && /^(SV_Target\d?|COLOR\d?)$/i.test(p.sem)))
      ?? fns.find((f) => /^(main|PSMain|ps_main|MainPS|PS|frag|Frag|pixel|Pixel|fragment|PixelShaderFunction|mainPS|ps)$/.test(f.name))
    if (!entry) throw new CodeError('This HLSL has no pixel shader function. Inoscula looks for the one marked ": SV_Target", or one named main, PSMain or frag.', 1)
    if (/^(vert|VSMain|vs_main|MainVS|VS|vertex)$/.test(entry.name)) throw new CodeError('This is a vertex shader. Inoscula reads the pixel (fragment) shader, the function that returns a color.', 1)
    const lineOf = lines(src.slice(0, entry.at)) + 1
    const g = (ty: string) => TYPES[ty] ?? ty
    const source = (f: Field): string => {
      const ty = g(f.type)
      const sem = (f.sem ?? '').toUpperCase()
      const n = /^[biu]?vec(\d)$/.exec(ty)?.[1]
      const size = n ? +n : 1
      const fit = (expr: string, from: number) => {
        if (size === from) return expr
        if (size < from) return `${expr}.${'xyzw'.slice(0, size)}`
        if (from === 1) return `${ty}(${expr})`
        const pad = Array.from({ length: size - from }, (_, k) => (size === 4 && k === size - from - 1 ? '1.0' : '0.0'))
        return `${ty}(${expr}, ${pad.join(', ')})`
      }
      if (/^(SV_POSITION|VPOS|POSITIONT)$/.test(sem) || (/^POSITION$/.test(sem) && /vertex|pos/i.test(f.name) && !/world/i.test(f.name))) return fit('gl_FragCoord', 4)
      if (/^(SV_ISFRONTFACE|VFACE|FACE)$/.test(sem)) return ty === 'bool' ? 'true' : '1.0'
      if (/uv|texcoord|coord/i.test(f.name) || (/^TEXCOORD0?$/.test(sem) && !/world|pos|normal|view|screen/i.test(f.name))) return fit('vUv', 2)
      if (/world.*pos|wpos|positionws/i.test(f.name)) return fit('world_pos', 3)
      if (/normal/i.test(f.name) || /^NORMAL/.test(sem)) return fit('normal', 3)
      if (/view.*dir|viewdir/i.test(f.name)) return fit('view_dir', 3)
      if (/obj.*pos|local.*pos/i.test(f.name)) return fit('object_pos', 3)
      if (/col/i.test(f.name) || /^COLOR/.test(sem)) return fit('vec4(1.0)', 4)
      if (/time/i.test(f.name)) return fit('iTime', 1)
      warnings.push({ line: lineOf, msg: `"${f.name}" comes from the vertex shader, which a material does not have, so it is 0 here.` })
      return size === 1 ? (ty === 'bool' ? 'false' : ty === 'int' ? '0' : '0.0') : `${ty}(0.0)`
    }
    const body: string[] = []
    const args: string[] = []
    let outArg: string | undefined
    entry.params.forEach((p, k) => {
      const ty = g(p.type)
      if (p.q.includes('out')) {
        body.push(`${ty} _hl_o${k};`); args.push(`_hl_o${k}`)
        if (!outArg && (!p.sem || /^(SV_Target0?|COLOR0?)$/i.test(p.sem))) outArg = `_hl_o${k}`
        return
      }
      if (structs.has(p.type)) {
        body.push(`${p.type} _hl_i${k};`)
        for (const f of structs.get(p.type)!) body.push(`_hl_i${k}.${f.name} = ${source(f)};`)
        args.push(`_hl_i${k}`)
        return
      }
      args.push(source(p))
    })
    // an HLSL entry called main has to make room for the GLSL main() below
    let callName = entry.name
    if (entry.name === 'main') { glsl = glsl.replace(/\bmain(\s*\()/g, '_hl_main$1'); callName = '_hl_main' }
    const call = `${callName}(${args.join(', ')})`
    const ret = g(entry.ret)
    let color: string
    if (ret === 'void') color = outArg ?? 'vec4(0.0)'
    else {
      body.push(`${ret} _hl_r = ${call};`)
      if (structs.has(entry.ret)) {
        const fields = structs.get(entry.ret)!
        const f = fields.find((x) => x.sem && /^(SV_Target0?|COLOR0?)$/i.test(x.sem)) ?? fields.find((x) => /4$/.test(x.type)) ?? fields[0]
        color = f ? `_hl_r.${f.name}` : 'vec4(0.0)'
      } else color = '_hl_r'
    }
    const outT = ret === 'void' ? g(entry.params.find((p) => `_hl_o${entry.params.indexOf(p)}` === outArg)?.type ?? 'float4') : structs.has(entry.ret) ? g(structs.get(entry.ret)!.find((x) => `_hl_r.${x.name}` === color)?.type ?? 'float4') : ret
    // alpha only counts when the shader is drawn see-through
    const seeThrough = kind === 'unity' ? /\bBlend\s+(SrcAlpha|One\s+OneMinusSrcAlpha)|"(Queue|RenderType)"\s*=\s*"Transparent"/.test(input) : false
    const to4 = outT === 'vec4' ? (seeThrough ? color : `vec4((${color}).rgb, 1.0)`) : outT === 'vec3' ? `vec4(${color}, 1.0)` : outT === 'vec2' ? `vec4(${color}, 0.0, 1.0)` : `vec4(vec3(${color}), 1.0)`
    tail.push(`void main() { ${body.join(' ')}${ret === 'void' ? ` ${call};` : ''} gl_FragColor = ${to4}; }`)
  }

  // ---- helpers, below everything
  const V = ['float', 'vec2', 'vec3', 'vec4']
  const used = (n: string) => glsl.includes(n + '(')
  if (used('_hl_saturate')) for (const ty of V) tail.push(`${ty} _hl_saturate(${ty} x) { return clamp(x, 0.0, 1.0); }`)
  if (used('_hl_fmod')) for (const ty of V) tail.push(`${ty} _hl_fmod(${ty} x, ${ty} y) { return x - y * trunc(x / y); }`, ...(ty === 'float' ? [] : [`${ty} _hl_fmod(${ty} x, float y) { return x - y * trunc(x / y); }`]))
  if (used('_hl_mad')) for (const ty of V) tail.push(`${ty} _hl_mad(${ty} a, ${ty} b, ${ty} c) { return a * b + c; }`)
  if (used('_hl_rcp')) for (const ty of V) tail.push(`${ty} _hl_rcp(${ty} x) { return 1.0 / x; }`)
  if (used('_hl_log10')) for (const ty of V) tail.push(`${ty} _hl_log10(${ty} x) { return log(x) * 0.43429448190325176; }`)
  if (used('_hl_exp10')) for (const ty of V) tail.push(`${ty} _hl_exp10(${ty} x) { return exp(x * 2.302585092994046); }`)
  if (used('_hl_sincos')) for (const ty of V) tail.push(`void _hl_sincos(${ty} x, out ${ty} s, out ${ty} c) { s = sin(x); c = cos(x); }`)
  if (used('_hl_clip')) for (const ty of V) tail.push(`void _hl_clip(${ty} x) { if (${ty === 'float' ? 'x < 0.0' : `any(lessThan(x, ${ty}(0.0)))`}) discard; }`)
  if (used('_hl_any')) { tail.push('bool _hl_any(float x) { return x != 0.0; }', 'bool _hl_any(bool x) { return x; }'); for (const n of [2, 3, 4]) tail.push(`bool _hl_any(vec${n} x) { return any(notEqual(x, vec${n}(0.0))); }`, `bool _hl_any(bvec${n} x) { return any(x); }`) }
  if (used('_hl_all')) { tail.push('bool _hl_all(float x) { return x != 0.0; }', 'bool _hl_all(bool x) { return x; }'); for (const n of [2, 3, 4]) tail.push(`bool _hl_all(vec${n} x) { return all(notEqual(x, vec${n}(0.0))); }`, `bool _hl_all(bvec${n} x) { return all(x); }`) }
  if (used('_hl_mul')) {
    // HLSL fills matrices row by row and GLSL column by column, so the same numbers make the transpose;
    // with that, mul(M, v) is v * M here, and mul(A, B) is B * A
    for (const n of [2, 3, 4]) tail.push(`vec${n} _hl_mul(mat${n} m, vec${n} v) { return v * m; }`, `vec${n} _hl_mul(vec${n} v, mat${n} m) { return m * v; }`, `mat${n} _hl_mul(mat${n} a, mat${n} b) { return b * a; }`, `mat${n} _hl_mul(float a, mat${n} b) { return a * b; }`, `mat${n} _hl_mul(mat${n} a, float b) { return a * b; }`)
    for (const ty of V) tail.push(`${ty} _hl_mul(float a, ${ty} b) { return a * b; }`, ...(ty === 'float' ? [] : [`${ty} _hl_mul(${ty} a, float b) { return a * b; }`]))
  }
  if (tail.length) glsl += '\n' + tail.join('\n') + '\n'
  return { glsl, kind, macros, warnings }
}
