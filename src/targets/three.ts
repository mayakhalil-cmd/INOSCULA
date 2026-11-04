// three.js target, which is also how RICO Engine runs Inoscula shaders. Pure strings: no three import here, so it
// works in RICO, in a plain page, or in Node. See ../rico.ts for the ready-made material.
//
// Unlit shaders become a ShaderMaterial (vertexShader + fragmentShader). Lit shaders patch three's own
// MeshPhysicalMaterial (litPatch), so three's lights, shadows, environment and tonemapping do the lighting.
import { body, helpers, LANG, noiseHelpers } from '../code.ts'
import type { IR } from '../spec.ts'

export interface ThreeOpts {
  /** Draw the mesh flattened into UV space (used by the parity test to compare against Blender bakes). */
  bakeUV?: boolean
  /** Meshes loaded from glTF store UVs with the origin top left; flip so they match Blender. Default false. */
  flipV?: boolean
}

export interface ThreeShader {
  lit: boolean
  /** Unlit only: a complete ShaderMaterial. */
  vertexShader: string
  fragmentShader: string
  /** Uniform names and starting values. Vectors are [x, y, z]. */
  uniforms: Record<string, number | [number, number, number]>
  /** Whether the mesh's vertex colours (shape data) are read. */
  vertexColors: boolean
  /** Lit only: turns three's MeshPhysicalMaterial shaders into this shader. Use in onBeforeCompile. */
  litPatch?: (vertexShader: string, fragmentShader: string) => { vertexShader: string; fragmentShader: string }
  /** An outline pass: draw the mesh again, inside out and pushed out along its normals. */
  outline?: { vertexShader: string; fragmentShader: string; uniforms: Record<string, string> }
  /** The same edits as data: [three chunk, code to add after it]. */
  litEdits?: { vertex: [string, string][]; fragment: [string, string][] }
}

/** Adds each edit's code after its chunk of three's shader. */
export function applyEdits(src: string, edits: [string, string][]) {
  for (const [find, add] of edits) {
    if (!src.includes(find)) throw new Error(`three.js changed: "${find}" not found`)
    src = src.replace(find, `${find}\n${add}`)
  }
  return src
}

// three.js is Y up; canonical space is Z up. (x, y, z) Y-up becomes (x, -z, y).
const TO_CANON = 'vec3 inoscula_canon(vec3 p) { return vec3(p.x, -p.z, p.y); }'
const VARYINGS = `varying vec3 g_vobj;
varying vec3 g_vonrm;
varying vec3 g_vwpos;
varying vec3 g_vwnrm;
varying vec3 g_vshape;`

function inputs(ir: IR, o: ThreeOpts, uvExpr: string) {
  return `  vec3 g_uv = vec3(${uvExpr}.x, ${o.flipV ? `1.0 - ${uvExpr}.y` : `${uvExpr}.y`}, 0.0);
  vec3 g_obj = inoscula_canon(g_vobj);
  vec3 g_onrm = inoscula_canon(normalize(g_vonrm));
  vec3 g_wpos = inoscula_canon(g_vwpos);
  vec3 g_nrm = inoscula_canon(normalize(g_vwnrm));
  vec3 g_view = ${o.bakeUV ? 'g_nrm' : 'inoscula_canon(normalize(cameraPosition - g_vwpos))'};
  float g_time = inoscula_time;
  vec3 g_light_dir = inoscula_canon(normalize(inoscula_light_dir));
  vec3 g_light_color = inoscula_light_color;
  float g_curv = mix(0.5, g_vshape.x, inoscula_has_shape(g_vshape));
  float g_occ = mix(1.0, g_vshape.y, inoscula_has_shape(g_vshape));
  float g_osize = inoscula_object_size;
${body(ir, LANG.glsl)}`
}

export function toThree(ir: IR, o: ThreeOpts = {}): ThreeShader {
  const uniforms: ThreeShader['uniforms'] = {}
  for (const p of ir.params) uniforms['p_' + p.id] = p.default
  uniforms.inoscula_time = 0
  uniforms.inoscula_light_dir = [0.4, 0.8, 0.45] // three space (Y up), towards the light
  uniforms.inoscula_light_color = [1, 1, 1]
  uniforms.inoscula_object_size = 2 // metres; look.fitTo(obj) sets it per object
  const vertexColors = ir.uses.has('curvature') || ir.uses.has('occlusion')
  const decl = [
    ...ir.params.map((p) => `uniform ${p.t === 'vec3' ? 'vec3' : 'float'} p_${p.id};`),
    'uniform float inoscula_time;',
    'uniform vec3 inoscula_light_dir;',
    'uniform vec3 inoscula_light_color;',
    'uniform float inoscula_object_size;',
  ].join('\n')
  // vertex colour red = curvature, green = occlusion; without shape data: flat and open
  const shape = vertexColors ? '#ifdef USE_COLOR\n  g_vshape = color.rgb;\n#else\n  g_vshape = vec3(0.5, 1.0, 0.0);\n#endif' : 'g_vshape = vec3(0.5, 1.0, 0.0);'

  const vertexShader = `${VARYINGS}
varying vec2 g_vuv;
void main() {
  g_vobj = position;
  g_vonrm = normal;
  vec4 w = modelMatrix * vec4(position, 1.0);
  g_vwpos = w.xyz;
  g_vwnrm = mat3(modelMatrix) * normal;
  g_vuv = uv;
  ${shape}
  ${o.bakeUV ? 'gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);' : 'gl_Position = projectionMatrix * viewMatrix * w;'}
}`

  const fragmentShader = `${VARYINGS}
varying vec2 g_vuv;
${decl}
${TO_CANON}
${helpers(ir, LANG.glsl)}
void main() {
${inputs(ir, o, 'g_vuv')}
${ir.cutout && !o.bakeUV ? '  if (g_out_alpha < 0.5) discard;\n' : ''}  gl_FragColor = vec4(g_out_color, ${ir.cutout ? '1.0' : 'g_out_alpha'});
${o.bakeUV ? '' : '  #include <tonemapping_fragment>\n  #include <colorspace_fragment>'}
}`

  const out: ThreeShader = { lit: ir.lit, vertexShader, fragmentShader, uniforms, vertexColors }
  if (ir.outline) {
    // uniforms of the outline pass, each naming the main shader's uniform it shares (so one slider drives both)
    const bind = (a: typeof ir.outline.width, name: string, fallback: string) => {
      if (a.k === 'ref') return a.id
      uniforms[name] = a.v as number | [number, number, number]
      return name
    }
    const w = bind(ir.outline.width, 'inoscula_outline_width', ''), c = bind(ir.outline.color, 'inoscula_outline_color', ''), b = bind(ir.outline.breakup, 'inoscula_outline_breakup', '')
    out.outline = {
      uniforms: { inoscula_outline_width: w, inoscula_outline_color: c, inoscula_outline_breakup: b },
      vertexShader: `uniform float inoscula_outline_width;
varying vec3 g_vobj;
varying vec3 g_vw;
varying vec3 g_vn;
void main() {
  g_vobj = position;
  g_vn = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
  vec3 p = position + normalize(normal) * inoscula_outline_width / max(length((modelMatrix * vec4(normalize(normal), 0.0)).xyz), 1e-6);
  g_vw = (modelMatrix * vec4(p, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`,
      fragmentShader: `uniform vec3 inoscula_outline_color;
uniform float inoscula_outline_breakup;
varying vec3 g_vobj;
varying vec3 g_vw;
varying vec3 g_vn;
${TO_CANON}
${noiseHelpers(LANG.glsl)}
void main() {
  // a broken, hand-inked line: the same noise in every tool eats into it
  if (inoscula_outline_breakup > 0.0 && inoscula_noise(inoscula_canon(g_vobj), 30.0, 2.0, 0.5, 2.0) < inoscula_outline_breakup) discard;
${ir.outline.rings ? `  // loose offset lines: thin rings across the halo, each wobbling on its own
  float g_face = abs(dot(normalize(g_vn), normalize(cameraPosition - g_vw)));
  if (g_face > 0.55) discard; // flat faces turned to the camera (a cylinder's cap) show no rings
  if (fract(g_face * ${ir.outline.rings}.0 * 1.6 + inoscula_noise(inoscula_canon(g_vobj), 3.0, 1.0, 0.5, 2.0) * 0.7) > 0.3) discard;
` : ''}  gl_FragColor = vec4(inoscula_outline_color, 1.0);
  #include <colorspace_fragment>
}`,
    }
  }
  if (ir.lit) {
    // each edit adds code right after one of three's own shader chunks; kept as plain data so it can be sent
    // to another page or process as it is
    const L = ir.layers
    const v: [string, string][] = [
      ['#include <common>', VARYINGS],
      ['#include <worldpos_vertex>', `  g_vobj = transformed;\n  g_vonrm = objectNormal;\n  g_vwpos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  g_vwnrm = mat3(modelMatrix) * objectNormal;\n  ${shape}`],
    ]
    const f: [string, string][] = [
      ['#include <common>', `${VARYINGS}\n${decl}\n${TO_CANON}\n${helpers(ir, LANG.glsl)}`],
      ['#include <clipping_planes_fragment>', inputs(ir, o, 'vUv')],
      ['#include <color_fragment>', '  diffuseColor.rgb = g_out_color;\n  diffuseColor.a *= g_out_alpha;'],
      ['#include <roughnessmap_fragment>', '  roughnessFactor = clamp(g_out_rough, 0.0, 1.0);'],
      ['#include <metalnessmap_fragment>', '  metalnessFactor = clamp(g_out_metal, 0.0, 1.0);'],
      ...(ir.bump ? [['#include <normal_fragment_maps>', '  normal = inoscula_bump(-vViewPosition, normal, g_out_bump);'] as [string, string]] : []),
      // layers: three's physical material has clear coat and sheen; it has no subsurface scattering
      ...(L.coat ? [['#include <lights_physical_fragment>', '#ifdef USE_CLEARCOAT\n  material.clearcoat = saturate(g_out_coat);\n  material.clearcoatRoughness = clamp(g_out_coat_rough, 0.0525, 1.0);\n#endif'] as [string, string]] : []),
      ...(L.sheen ? [['#include <lights_physical_fragment>', '#ifdef USE_SHEEN\n  material.sheenColor = g_out_sheen_color * saturate(g_out_sheen);\n  material.sheenRoughness = clamp(g_out_sheen_rough, 0.07, 1.0);\n#endif'] as [string, string]] : []),
      ['#include <emissivemap_fragment>', '  totalEmissiveRadiance += g_out_emit;'],
    ]
    out.litEdits = { vertex: v, fragment: f }
    out.litPatch = (vs, fs) => ({ vertexShader: applyEdits(vs, v), fragmentShader: applyEdits(fs, f) })
  }
  return out
}
