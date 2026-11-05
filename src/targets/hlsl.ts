// HLSL targets: Unreal (an editor Python script that builds the material, parameters and all) and Unity
// (a Custom Function file for Shader Graph). Both share one HLSL function so they compute the same thing.
import { body, helpers, LANG, noiseHelpers, num } from '../code.ts'
import { InosculaError, paramDesc, type IR } from '../spec.ts'

// Inputs the function takes, in order, and which source op needs each.
const INPUTS: [name: string, type: 'float' | 'float3', needs: string[]][] = [
  ['g_uv', 'float3', ['uv']],
  ['g_obj', 'float3', ['object_pos']],
  ['g_onrm', 'float3', ['object_normal']],
  ['g_wpos', 'float3', ['world_pos']],
  ['g_nrm', 'float3', ['normal']],
  ['g_view', 'float3', ['view_dir']],
  ['g_time', 'float', ['time']],
  ['g_light_dir', 'float3', ['light_dir']],
  ['g_light_color', 'float3', ['light_color']],
  ['g_shape', 'float3', ['curvature', 'occlusion']],
  ['g_osize', 'float', ['object_size']],
]

/** One HLSL function, run(...), that both Unreal and Unity call. Outputs go out through out parameters. */
export function hlslFunction(ir: IR, fname: string, bumpScale = 1) {
  const ins = INPUTS.filter(([, , need]) => need.some((n) => ir.uses.has(n)))
  const bump = ir.lit && Boolean(ir.bump)
  const sig = [
    ...ins.map(([n, t]) => `${t} ${n}`),
    ...ir.params.map((p) => `${p.t === 'vec3' ? 'float3' : 'float'} p_${p.id}`),
    ...(bump ? ['float3 g_bump_pos', 'float3 g_bump_nrm'] : []),
    'out float3 o_color', 'out float o_alpha', 'out float o_rough', 'out float o_metal', 'out float3 o_emit', 'out float3 o_normal',
    'out float o_coat', 'out float o_coat_rough', 'out float3 o_sheen', 'out float o_sheen_rough', 'out float o_sss',
    ...(ir.glass ? ['out float o_glass', 'out float o_ior', 'out float o_disp'] : []),
  ]
  return {
    ins,
    bump,
    code: `${helpers(ir, LANG.hlsl)}
void ${fname}(${sig.join(', ')}) {
  float g_curv = ${ins.some(([n]) => n === 'g_shape') ? 'lerp(0.5, g_shape.x, inoscula_has_shape(g_shape))' : '0.5'};
  float g_occ = ${ins.some(([n]) => n === 'g_shape') ? 'lerp(1.0, g_shape.y, inoscula_has_shape(g_shape))' : '1.0'};
${body(ir, LANG.hlsl)}
  o_color = g_out_color;
  o_alpha = g_out_alpha;
  o_rough = saturate(g_out_rough);
  o_metal = saturate(g_out_metal);
  o_emit = g_out_emit;
  o_normal = ${bump ? `inoscula_bump(g_bump_pos, g_bump_nrm, g_out_bump * ${num(bumpScale)})` : 'float3(0.0, 0.0, 1.0)'};
  o_coat = saturate(g_out_coat);
  o_coat_rough = saturate(g_out_coat_rough);
  o_sheen = g_out_sheen_color * saturate(g_out_sheen);
  o_sheen_rough = saturate(g_out_sheen_rough);
  o_sss = saturate(g_out_sss);${ir.glass ? '\n  o_glass = g_out_glass;\n  o_ior = g_out_ior;\n  o_disp = g_out_disp;' : ''}
}`,
  }
}

// ------------------------------------------------------------------ Unreal

/** Glass, Python side: the color, emissive and glass values are held here instead of going straight to the
 *  material, then unrealGlass() mixes in the scene behind and connects them. */
export const UNREAL_ROUTE = `# glass: the color and the glass values meet in the glass step at the end
routed = {}
def route(a, a_out, key):
    routed[key] = (a, a_out)
`

/** Glass, Python side: three Scene Color nodes (Offset Fraction mode) read the scene behind, each shifted along the
 *  view space normal by a little more or less, so red, green and blue bend apart like a prism. Needs a
 *  translucent material; Unreal only offers Scene Color there. */
export function unrealGlass(lit: boolean, dx = 0, dy = 0) {
  const bend = 'float2 d = -normalize(N).xy * float2(1.0, -1.0) * (Ior - 1.0) * 0.2;\nOffsetG = d;\nOffsetB = d * (1.0 + 0.5 * Dispersion);\nreturn d * (1.0 - 0.5 * Dispersion);'
  return `# ---- glass: the scene behind, bent along the surface (Scene Color in Offset Fraction mode, one per color)
gx, gy = ${dx}, ${dy}
gl_n = add(unreal.MaterialExpressionVertexNormalWS, gx + 400, gy + 700)
gl_v = add(unreal.MaterialExpressionTransform, gx + 600, gy + 700)
gl_v.set_editor_property("transform_source_type", unreal.MaterialVectorCoordTransformSource.TRANSFORMSOURCE_WORLD)
gl_v.set_editor_property("transform_type", unreal.MaterialVectorCoordTransform.TRANSFORM_VIEW)
link(gl_n, "", gl_v, "")
gl_bend = add(unreal.MaterialExpressionCustom, gx + 850, gy + 700)
gl_bend.set_editor_property("description", "Glass bend")
gl_bend.set_editor_property("code", ${JSON.stringify(bend)})
gl_bend.set_editor_property("output_type", unreal.CustomMaterialOutputType.CMOT_FLOAT2)
gl_bend.set_editor_property("inputs", [custom_input(n) for n in ("N", "Ior", "Dispersion")])
gl_bend.set_editor_property("additional_outputs", [custom_output("OffsetG", unreal.CustomMaterialOutputType.CMOT_FLOAT2), custom_output("OffsetB", unreal.CustomMaterialOutputType.CMOT_FLOAT2)])
link(gl_v, "", gl_bend, "N")
a, a_out = routed["INOSCULA_IOR"]
link(a, a_out, gl_bend, "Ior")
a, a_out = routed["INOSCULA_DISPERSION"]
link(a, a_out, gl_bend, "Dispersion")
gl_scene = []
for i, offset in enumerate(("", "OffsetG", "OffsetB")):
    sc = add(unreal.MaterialExpressionSceneColor, gx + 1100, gy + 550 + i * 160)
    sc.set_editor_property("input_mode", unreal.MaterialSceneAttributeInputMode.OFFSET_FRACTION)
    sc_in = L.get_material_expression_input_names(sc)
    link(gl_bend, offset, sc, sc_in[0] if sc_in else "")
    gl_scene.append(sc)
${lit ? `gl_emit = "MP_EMISSIVE_COLOR" in routed
gl_mix = add(unreal.MaterialExpressionCustom, gx + 1350, gy + 600)
gl_mix.set_editor_property("description", "Glass")
gl_mix.set_editor_property("code", "float g = saturate(Glass);\\nGlassEmissive = " + ("Emit + " if gl_emit else "") + "float3(SceneR.r, SceneG.g, SceneB.b) * g;\\nreturn Color * (1.0 - g);")
gl_mix.set_editor_property("output_type", unreal.CustomMaterialOutputType.CMOT_FLOAT3)
gl_mix.set_editor_property("inputs", [custom_input(n) for n in ("Color", "Glass", "SceneR", "SceneG", "SceneB") + (("Emit",) if gl_emit else ())])
gl_mix.set_editor_property("additional_outputs", [custom_output("GlassEmissive", unreal.CustomMaterialOutputType.CMOT_FLOAT3)])
a, a_out = routed["MP_BASE_COLOR"]
link(a, a_out, gl_mix, "Color")
if gl_emit:
    a, a_out = routed["MP_EMISSIVE_COLOR"]
    link(a, a_out, gl_mix, "Emit")` : `gl_mix = add(unreal.MaterialExpressionCustom, gx + 1350, gy + 600)
gl_mix.set_editor_property("description", "Glass")
gl_mix.set_editor_property("code", "return lerp(Color, float3(SceneR.r, SceneG.g, SceneB.b), saturate(Glass));")
gl_mix.set_editor_property("output_type", unreal.CustomMaterialOutputType.CMOT_FLOAT3)
gl_mix.set_editor_property("inputs", [custom_input(n) for n in ("Color", "Glass", "SceneR", "SceneG", "SceneB")])
a, a_out = routed["MP_EMISSIVE_COLOR"]
link(a, a_out, gl_mix, "Color")`}
a, a_out = routed["INOSCULA_GLASS"]
link(a, a_out, gl_mix, "Glass")
for sc, pin in zip(gl_scene, ("SceneR", "SceneG", "SceneB")):
    link(sc, "", gl_mix, pin)
${lit ? `link_out(gl_mix, "", unreal.MaterialProperty.MP_BASE_COLOR)
link_out(gl_mix, "GlassEmissive", unreal.MaterialProperty.MP_EMISSIVE_COLOR)` : 'link_out(gl_mix, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)'}
`
}

export interface UnrealOpts {
  /** Content folder for the new asset. */
  folder?: string
  /** "material" (default): a ready material. "function": a Material Function with one output per channel, to plug
   *  into your own materials, layer stacks or Substrate graphs. */
  as?: 'material' | 'function'
  /** Lit shaders: build a Substrate Slab (Unreal 5.4 and later, with Substrate on) instead of the legacy inputs. */
  substrate?: boolean
  /** The graph, stored on the asset so Inoscula can read it back later (Unreal to Inoscula to Blender and back). */
  graphJson?: string
}

export function toUnreal(ir: IR, o: UnrealOpts = {}): string {
  const fn = hlslFunction(ir, 'run', 100) // bump heights are meters; Unreal works in centimeters
  const name = 'M_' + ir.name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')
  // Unreal is Z up, left handed, centimeters. Canonical = (x, -y, z) and meters.
  const prep: Record<string, string> = {
    g_uv: 'float3(UV.x, 1.0 - UV.y, 0.0)',
    g_obj: 'float3(ObjPos.x, -ObjPos.y, ObjPos.z) * 0.01',
    g_onrm: 'normalize(float3(ObjNrm.x, -ObjNrm.y, ObjNrm.z))',
    g_wpos: 'float3(WPos.x, -WPos.y, WPos.z) * 0.01',
    g_nrm: 'normalize(float3(WNrm.x, -WNrm.y, WNrm.z))',
    g_view: 'normalize(float3(CamVec.x, -CamVec.y, CamVec.z))',
    g_time: 'Time',
    g_light_dir: 'normalize(float3(LightDir.x, -LightDir.y, LightDir.z))',
    g_light_color: 'LightColor.xyz',
    g_shape: 'VCol.xyz',
    g_osize: 'ObjSize * 0.01',
  }
  const pin: Record<string, string> = { g_osize: 'ObjSize', g_uv: 'UV', g_obj: 'ObjPos', g_onrm: 'ObjNrm', g_wpos: 'WPos', g_nrm: 'WNrm', g_view: 'CamVec', g_time: 'Time', g_light_dir: 'LightDir', g_light_color: 'LightColor', g_shape: 'VCol' }
  const call = [...fn.ins.map(([n]) => prep[n]), ...ir.params.map((p) => (p.t === 'vec3' ? `P_${p.id}.xyz` : `P_${p.id}`)), ...(fn.bump ? ['WPos', 'normalize(WNrm)'] : []), 'c', 'a', 'r', 'm', 'e', 'n', 'k', 'kr', 'sh', 'shr', 'ss', ...(ir.glass ? ['gl', 'gi', 'gd'] : [])]
  const lit = ir.lit
  const asFn = o.as === 'function'
  const substrate = lit && Boolean(o.substrate)
  // extra outputs of the Custom node: [name, type, what it carries]
  const extra: [string, string, string][] = lit ? [
    ['InosculaRoughness', 'CMOT_FLOAT1', 'r'], ['InosculaMetallic', 'CMOT_FLOAT1', 'm'], ['InosculaEmissive', 'CMOT_FLOAT3', 'e'], ['InosculaNormal', 'CMOT_FLOAT3', 'n'],
    ['InosculaCoat', 'CMOT_FLOAT1', 'k'], ['InosculaCoatRoughness', 'CMOT_FLOAT1', 'kr'], ['InosculaSheen', 'CMOT_FLOAT3', 'sh'], ['InosculaSheenRoughness', 'CMOT_FLOAT1', 'shr'], ['InosculaSubsurface', 'CMOT_FLOAT1', 'ss'],
    // Substrate wants albedo and F0 rather than base color and metallic
    ['InosculaDiffuseAlbedo', 'CMOT_FLOAT3', 'c * (1.0 - m)'], ['InosculaF0', 'CMOT_FLOAT3', 'lerp((float3)0.04, c, m)'],
  ] : []
  if (ir.glass) extra.push(['InosculaGlass', 'CMOT_FLOAT1', 'gl'], ['InosculaGlassIOR', 'CMOT_FLOAT1', 'gi'], ['InosculaGlassDispersion', 'CMOT_FLOAT1', 'gd'])
  if (ir.glass && substrate) throw new InosculaError('Glass is not wired into Substrate yet. Untick Substrate (the legacy inputs work with Substrate off).')
  const custom = `struct InosculaFn {
${fn.code}
};
InosculaFn G;
float3 c; float a; float r; float m; float3 e; float3 n; float k; float kr; float3 sh; float shr; float ss;${ir.glass ? ' float gl; float gi; float gd;' : ''}
G.run(${call.join(', ')});
${extra.map(([nm, , v]) => `${nm} = ${v};`).join('\n')}${extra.length ? '\n' : ''}return float4(c, a);`

  const py = (s: string) => JSON.stringify(s)
  const sources: Record<string, string> = {
    UV: 'unreal.MaterialExpressionTextureCoordinate',
    ObjPos: 'unreal.MaterialExpressionLocalPosition',
    WPos: 'unreal.MaterialExpressionWorldPosition',
    WNrm: 'unreal.MaterialExpressionVertexNormalWS',
    CamVec: 'unreal.MaterialExpressionCameraVectorWS',
    Time: 'unreal.MaterialExpressionTime',
    VCol: 'unreal.MaterialExpressionVertexColor',
  }
  const lines: string[] = []
  let y = 0
  const pins = [...fn.ins.map(([n]) => pin[n])]
  if (fn.bump) { if (!pins.includes('WPos')) pins.push('WPos'); if (!pins.includes('WNrm')) pins.push('WNrm') }
  for (const p of pins) {
    if (p === 'ObjNrm') {
      lines.push(`src_ObjNrm_n = add(unreal.MaterialExpressionVertexNormalWS, -900, ${y})`)
      lines.push(`src_ObjNrm = add(unreal.MaterialExpressionTransform, -650, ${y})`)
      lines.push(`src_ObjNrm.set_editor_property("transform_source_type", unreal.MaterialVectorCoordTransformSource.TRANSFORMSOURCE_WORLD)`)
      lines.push(`src_ObjNrm.set_editor_property("transform_type", unreal.MaterialVectorCoordTransform.TRANSFORM_LOCAL)`)
      lines.push(`L.connect_material_expressions(src_ObjNrm_n, "", src_ObjNrm, "")`)
    } else if (p === 'ObjSize') {
      // the object's size: its bounds radius, doubled (centimeters; the shader turns it into meters)
      lines.push(`src_ObjSize_r = add(unreal.MaterialExpressionObjectRadius, -900, ${y})`)
      lines.push(`src_ObjSize = add(unreal.MaterialExpressionMultiply, -650, ${y})`)
      lines.push(`src_ObjSize.set_editor_property("const_b", 2.0)`)
      lines.push(`L.connect_material_expressions(src_ObjSize_r, "", src_ObjSize, "A")`)
    } else if (p === 'LightDir' || p === 'LightColor') {
      const v = p === 'LightDir' ? [0.4, -0.45, 0.8] : [1, 1, 1]
      lines.push(`src_${p} = vec_param(${py(p === 'LightDir' ? 'Inoscula Light Direction' : 'Inoscula Light Color')}, (${v.join(', ')}), -650, ${y})`)
    } else lines.push(`src_${p} = add(${sources[p]}, -650, ${y})`)
    lines.push(`pins.append((${py(p)}, src_${p}))`)
    y += 120
  }
  for (const p of ir.params) {
    if (p.t === 'vec3') {
      const v = p.default as number[]
      lines.push(`src = vec_param(${py(p.label ?? p.id)}, (${v.map(num).join(', ')}), -650, ${y})`)
    } else {
      lines.push(`src = add(unreal.MaterialExpressionScalarParameter, -650, ${y})`)
      lines.push(`src.set_editor_property("parameter_name", ${py(p.label ?? p.id)})`)
      lines.push(`src.set_editor_property("default_value", ${num(p.default as number)})`)
      if (p.min !== undefined && p.max !== undefined) lines.push(`src.set_editor_property("slider_min", ${num(p.min)}); src.set_editor_property("slider_max", ${num(p.max)})`)
    }
    if (p.group) lines.push(`src.set_editor_property("group", ${py(p.group)})`)
    if (paramDesc(p)) lines.push(`src.set_editor_property("desc", ${py(paramDesc(p))})`)
    lines.push(`pins.append((${py('P_' + p.id)}, src))`)
    y += 120
  }

  // Where each channel goes. In a material: material properties. In a function: named outputs.
  const routes: [from: string, to: string][] = [['RGB', 'BaseColor']]
  if (!lit) routes[0] = ['RGB', 'Emissive']
  if (ir.alpha) routes.push(['A', ir.cutout ? 'OpacityMask' : 'Opacity'])
  if (lit) {
    routes.push(['InosculaRoughness', 'Roughness'], ['InosculaMetallic', 'Metallic'], ['InosculaEmissive', 'Emissive'])
    if (fn.bump) routes.push(['InosculaNormal', 'Normal'])
  }
  const prop: Record<string, string> = { BaseColor: 'MP_BASE_COLOR', Emissive: 'MP_EMISSIVE_COLOR', Opacity: 'MP_OPACITY', OpacityMask: 'MP_OPACITY_MASK', Roughness: 'MP_ROUGHNESS', Metallic: 'MP_METALLIC', Normal: 'MP_NORMAL' }
  const fnOuts = asFn ? [...routes.map(([, to]) => to), ...(lit ? ['Coat', 'CoatRoughness', 'Sheen', 'SheenRoughness', 'Subsurface', 'DiffuseAlbedo', 'F0'] : []), ...(ir.glass ? ['Glass', 'GlassIOR', 'GlassDispersion'] : [])] : []
  const fnFrom: Record<string, string> = { Glass: 'InosculaGlass', GlassIOR: 'InosculaGlassIOR', GlassDispersion: 'InosculaGlassDispersion', Coat: 'InosculaCoat', CoatRoughness: 'InosculaCoatRoughness', Sheen: 'InosculaSheen', SheenRoughness: 'InosculaSheenRoughness', Subsurface: 'InosculaSubsurface', DiffuseAlbedo: 'InosculaDiffuseAlbedo', F0: 'InosculaF0' }

  return `# ${ir.name}, made with Inoscula.
# Run inside the Unreal Editor: Tools > Execute Python Script (needs the Python Editor Script Plugin).
# It builds ${o.folder ?? '/Game/Inoscula'}/${asFn ? 'MF_' + name.slice(2) : name}: one Custom node holding the shader, wired to real
# parameters, so everything stays editable${asFn ? ' wherever you use the function' : ' in a Material Instance'}.${asFn ? `
# Material Function: drag it into any material, Substrate graph or layer stack. One output per channel.` : ''}${lit ? `
# Lit: Unreal lights it itself (Lumen, shadows, reflections).` : ''}${substrate ? `
# Substrate: the material ends in a Substrate Slab (needs Substrate turned on in Project Settings).` : ''}${ir.uses.has('curvature') || ir.uses.has('occlusion') ? `
# Shape data: import the model that Inoscula Studio's Prepare model saved, with vertex colors kept.` : ''}
# The Inoscula graph is stored on the asset (metadata tag "inoscula"); inoscula_from_unreal.py reads it back with your edits.
import unreal

FOLDER = ${py(o.folder ?? '/Game/Inoscula')}
NAME = ${py(asFn ? 'MF_' + name.slice(2) : name)}
L = unreal.MaterialEditingLibrary
tools = unreal.AssetToolsHelpers.get_asset_tools()
path = FOLDER + "/" + NAME
IS_FUNCTION = ${asFn ? 'True' : 'False'}
if unreal.EditorAssetLibrary.does_asset_exist(path):
    mat = unreal.EditorAssetLibrary.load_asset(path)
    if IS_FUNCTION:
        L.delete_all_material_expressions_in_function(mat)
    else:
        L.delete_all_material_expressions(mat)
elif IS_FUNCTION:
    mat = tools.create_asset(NAME, FOLDER, unreal.MaterialFunction, unreal.MaterialFunctionFactoryNew())
else:
    mat = tools.create_asset(NAME, FOLDER, unreal.Material, unreal.MaterialFactoryNew())
if not IS_FUNCTION:
    mat.set_editor_property("shading_model", unreal.MaterialShadingModel.${lit ? 'MSM_DEFAULT_LIT' : 'MSM_UNLIT'})
    mat.set_editor_property("blend_mode", unreal.BlendMode.${ir.cutout ? 'BLEND_MASKED' : ir.alpha || ir.glass ? 'BLEND_TRANSLUCENT' : 'BLEND_OPAQUE'})${ir.cutout ? '\n    mat.set_editor_property("two_sided", True)' : ''}
${lit && fn.bump ? '    mat.set_editor_property("tangent_space_normal", False)  # the Custom node gives a world space normal\n' : ''}
def custom_input(name):
    # Unreal's CustomInput takes no constructor arguments, so set the name afterwards
    c = unreal.CustomInput()
    c.set_editor_property("input_name", name)
    return c

def custom_output(name, kind):
    c = unreal.CustomOutput()
    c.set_editor_property("output_name", name)
    c.set_editor_property("output_type", kind)
    return c

failed = []
def link(a, a_out, b, b_in):
    if not L.connect_material_expressions(a, a_out, b, b_in):
        failed.append("%s.%s -> %s.%s" % (a.get_name(), a_out or "out", b.get_name(), b_in or "in"))

def link_out(a, a_out, prop):
    if not L.connect_material_property(a, a_out, prop):
        failed.append("%s.%s -> %s" % (a.get_name(), a_out or "out", prop))

def report():
    count = len(failed)
    if failed:
        unreal.log_error("Inoscula: %d connections failed:" % len(failed))
        for f in failed:
            unreal.log_error("  " + f)
        del failed[:]
    return count

def add(cls, x, y):
    if IS_FUNCTION:
        return L.create_material_expression_in_function(mat, cls, x, y)
    return L.create_material_expression(mat, cls, x, y)

def vec_param(name, v, x, y):
    e = add(unreal.MaterialExpressionVectorParameter, x, y)
    e.set_editor_property("parameter_name", name)
    e.set_editor_property("default_value", unreal.LinearColor(v[0], v[1], v[2], 1.0))
    return e

def wire(src, out_name, dst, in_names):
    for n in in_names:
        if L.connect_material_expressions(src, out_name, dst, n):
            return True
    unreal.log_warning("Inoscula: could not connect %s to %s" % (out_name, in_names))
    return False

pins = []
${lines.join('\n')}

custom = add(unreal.MaterialExpressionCustom, -250, 0)
custom.set_editor_property("description", ${py(ir.name)})
custom.set_editor_property("output_type", unreal.CustomMaterialOutputType.CMOT_FLOAT4)
custom.set_editor_property("code", ${py(custom)})
custom.set_editor_property("inputs", [custom_input(n) for n, _ in pins])
${extra.length ? `custom.set_editor_property("additional_outputs", [
${extra.map(([nm, ty]) => `    custom_output(${py(nm)}, unreal.CustomMaterialOutputType.${ty}),`).join('\n')}
])
` : ''}for n, e in pins:
    L.connect_material_expressions(e, "", custom, n)

def mask(r, g, b, a, y):
    m = add(unreal.MaterialExpressionComponentMask, 0, y)
    for k, v in (("r", r), ("g", g), ("b", b), ("a", a)):
        m.set_editor_property(k, v)
    L.connect_material_expressions(custom, "", m, "")
    return m

RGB = mask(True, True, True, False, 0)
A = mask(False, False, False, True, 160)
OUT = {"RGB": (RGB, ""), "A": (A, "")}
def src(name):
    return OUT.get(name, (custom, name))

${asFn ? `# ---- function outputs
for i, (out_name, source) in enumerate(${'['}${fnOuts.map((to) => `(${py(to)}, ${py(routes.find(([, t]) => t === to)?.[0] ?? fnFrom[to])})`).join(', ')}${']'}):
    fo = add(unreal.MaterialExpressionFunctionOutput, 400, i * 120)
    fo.set_editor_property("output_name", out_name)
    e, pin = src(source)
    L.connect_material_expressions(e, pin, fo, "")
${substrate ? `slab = add(unreal.MaterialExpressionSubstrateSlabBSDF, 250, -300)
${substrateWiring()}
fo = add(unreal.MaterialExpressionFunctionOutput, 600, -300)
fo.set_editor_property("output_name", "Substrate")
L.connect_material_expressions(slab, "", fo, "")
` : ''}L.layout_material_function_expressions(mat)
L.update_material_function(mat, None)` : substrate ? `# ---- Substrate Slab
slab = add(unreal.MaterialExpressionSubstrateSlabBSDF, 250, 0)
${substrateWiring()}
L.connect_material_property(slab, "", unreal.MaterialProperty.MP_FRONT_MATERIAL)
${ir.alpha ? `L.connect_material_property(A, "", unreal.MaterialProperty.${ir.cutout ? 'MP_OPACITY_MASK' : 'MP_OPACITY'})\n` : ''}L.layout_material_expressions(mat)
L.recompile_material(mat)` : `# ---- material inputs
${ir.glass ? UNREAL_ROUTE : ''}${routes.map(([from, to]) => `e, pin = src(${py(from)})\n${ir.glass && (to === 'Emissive' || to === 'BaseColor') ? `route(e, pin, ${py(prop[to])})` : `L.connect_material_property(e, pin, unreal.MaterialProperty.${prop[to]})`}`).join('\n')}
${ir.glass ? `route(custom, "InosculaGlass", "INOSCULA_GLASS")
route(custom, "InosculaGlassIOR", "INOSCULA_IOR")
route(custom, "InosculaGlassDispersion", "INOSCULA_DISPERSION")
${unrealGlass(lit)}if report():
    unreal.log_error("Inoscula: the glass step is not fully connected; the material will show the plain color")
` : ''}L.layout_material_expressions(mat)
L.recompile_material(mat)`}

# keep the Inoscula graph on the asset, so it can travel back out with any changes
unreal.EditorAssetLibrary.set_metadata_tag(mat, "inoscula", ${py(o.graphJson ?? JSON.stringify(ir.source))})
unreal.EditorAssetLibrary.save_asset(path)
print("Inoscula: built " + path)
${ir.outline ? unrealOutline() : ''}${asFn ? '' : unrealApply(Boolean(ir.outline))}`

  // The outline as an Overlay Material: the mesh drawn again, pushed out along its normals, showing only its
  // inside faces. Set it in the Static Mesh component's Overlay Material slot (Unreal 5.1 and later).
  function unrealOutline() {
    const o = ir.outline!
    const pOf = (a: typeof o.width) => (a.k === 'ref' ? ir.params.find((q) => 'p_' + q.id === a.id) : undefined)
    const wp = pOf(o.width), cp = pOf(o.color)
    const wv = wp ? (wp.default as number) : (o.width.v as number), cv = (cp ? cp.default : o.color.v) as number[]
    const bp = pOf(o.breakup), bv = bp ? (bp.default as number) : (o.breakup.v as number)
    const fp = pOf(o.offset), fv = fp ? (fp.default as number) : (o.offset.v as number)
    const op = pOf(o.boil), ov = op ? (op.default as number) : (o.boil.v as number)
    const maskCode = [
      `struct InosculaOutline {\n${noiseHelpers(LANG.hlsl)}\n};`,
      'InosculaOutline G;',
      'if (Sign >= 0.0) return 0.0;',
      '// boil: the noise jumps to a new place this many times a second, so the line redraws like hand animation',
      'float seed = Boil > 0.0 ? floor(Time * Boil) : 0.0;',
      'float3 q = float3(P.x, -P.y, P.z) * 0.01 + frac(seed * float3(0.1031, 0.1030, 0.0973)) * 37.0;',
      'if (Breakup > 0.0 && G.inoscula_noise(q, 30.0, 2.0, 0.5, 2.0) < Breakup) return 0.0;',
      'float face = abs(dot(normalize(N), normalize(C)));',
      '// offset: leave a gap between the surface and the line (measured as if the shape were round)',
      'if (Offset > 0.0) {',
      '  float r = Radius * 0.01;',
      '  float k = (r + Offset) / (r + Offset + Width);',
      '  if (face > sqrt(max(1.0 - k * k, 0.0))) return 0.0;',
      '}',
      ...(o.rings ? ['if (face > 0.55) return 0.0;', `if (frac(face * ${o.rings}.0 * 1.6 + G.inoscula_noise(q, 3.0, 1.0, 0.5, 2.0) * 0.7) > 0.3) return 0.0;`] : []),
      'return 1.0;',
    ].join('\n')
    return `
# ---- outline: an Overlay Material (Static Mesh component > Overlay Material)
opath = FOLDER + "/" + NAME + "_Outline"
if unreal.EditorAssetLibrary.does_asset_exist(opath):
    om = unreal.EditorAssetLibrary.load_asset(opath)
    L.delete_all_material_expressions(om)
else:
    om = tools.create_asset(NAME + "_Outline", FOLDER, unreal.Material, unreal.MaterialFactoryNew())
om.set_editor_property("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)
om.set_editor_property("blend_mode", unreal.BlendMode.BLEND_MASKED)
om.set_editor_property("two_sided", True)
def oadd(cls, x, y):
    return L.create_material_expression(om, cls, x, y)
ow = oadd(unreal.MaterialExpressionScalarParameter, -700, 0)
ow.set_editor_property("parameter_name", ${py(wp ? (wp.label ?? wp.id) : 'Outline Width')})
ow.set_editor_property("default_value", ${num(wv)})
ooff = oadd(unreal.MaterialExpressionScalarParameter, -900, 0)
ooff.set_editor_property("parameter_name", ${py(fp ? (fp.label ?? fp.id) : 'Outline Offset')})
ooff.set_editor_property("default_value", ${num(fv)})
opush = oadd(unreal.MaterialExpressionAdd, -600, 0)
link(ow, "", opush, "A")
link(ooff, "", opush, "B")
ocm = oadd(unreal.MaterialExpressionMultiply, -500, 0)
ocm.set_editor_property("const_b", 100.0)  # meters to centimeters
link(opush, "", ocm, "A")
on = oadd(unreal.MaterialExpressionVertexNormalWS, -500, 120)
owpo = oadd(unreal.MaterialExpressionMultiply, -300, 60)
L.connect_material_expressions(ocm, "", owpo, "A")
L.connect_material_expressions(on, "", owpo, "B")
L.connect_material_property(owpo, "", unreal.MaterialProperty.MP_WORLD_POSITION_OFFSET)
oc = oadd(unreal.MaterialExpressionVectorParameter, -300, 260)
oc.set_editor_property("parameter_name", ${py(cp ? (cp.label ?? cp.id) : 'Outline Color')})
oc.set_editor_property("default_value", unreal.LinearColor(${cv.map(num).join(', ')}, 1.0))
L.connect_material_property(oc, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)
osg = oadd(unreal.MaterialExpressionTwoSidedSign, -500, 420)
omask = oadd(unreal.MaterialExpressionCustom, -300, 420)
omask.set_editor_property("code", ${py(maskCode)})
omask.set_editor_property("inputs", [custom_input(n) for n in ("Sign", "P", "Breakup", "N", "C", "Boil", "Time", "Offset", "Width", "Radius")])
omask.set_editor_property("output_type", unreal.CustomMaterialOutputType.CMOT_FLOAT1)
L.connect_material_expressions(osg, "", omask, "Sign")
olp = oadd(unreal.MaterialExpressionLocalPosition, -500, 540)
L.connect_material_expressions(olp, "", omask, "P")
obk = oadd(unreal.MaterialExpressionScalarParameter, -500, 660)
obk.set_editor_property("parameter_name", ${py(bp ? (bp.label ?? bp.id) : 'Outline Breakup')})
obk.set_editor_property("default_value", ${num(bv)})
L.connect_material_expressions(obk, "", omask, "Breakup")
onn = oadd(unreal.MaterialExpressionVertexNormalWS, -700, 780)
L.connect_material_expressions(onn, "", omask, "N")
ocv = oadd(unreal.MaterialExpressionCameraVectorWS, -700, 900)
L.connect_material_expressions(ocv, "", omask, "C")
oboil = oadd(unreal.MaterialExpressionScalarParameter, -700, 1020)
oboil.set_editor_property("parameter_name", ${py(op ? (op.label ?? op.id) : 'Outline Boil')})
oboil.set_editor_property("default_value", ${num(ov)})
link(oboil, "", omask, "Boil")
otime = oadd(unreal.MaterialExpressionTime, -700, 1140)
link(otime, "", omask, "Time")
link(ooff, "", omask, "Offset")
link(ow, "", omask, "Width")
orad = oadd(unreal.MaterialExpressionObjectRadius, -700, 1260)
link(orad, "", omask, "Radius")
L.connect_material_property(omask, "", unreal.MaterialProperty.MP_OPACITY_MASK)
L.layout_material_expressions(om)
L.recompile_material(om)
unreal.EditorAssetLibrary.save_asset(opath)
report()
print("Inoscula: built " + opath + " (use it as the Overlay Material)")
`
  }

  function substrateWiring() {
    const pairs: [string, string[]][] = [
      ['InosculaDiffuseAlbedo', ['Diffuse Albedo', 'DiffuseAlbedo']], ['InosculaF0', ['F0']], ['InosculaRoughness', ['Roughness']],
      ['InosculaEmissive', ['Emissive Color', 'EmissiveColor']],
    ]
    if (fn.bump) pairs.push(['InosculaNormal', ['Normal']])
    if (ir.layers.sheen) pairs.push(['InosculaSheen', ['Fuzz Color', 'FuzzColor']], ['InosculaSheenRoughness', ['Fuzz Roughness', 'FuzzRoughness']])
    if (ir.layers.coat) pairs.push(['InosculaCoatRoughness', ['Second Roughness', 'SecondRoughness']], ['InosculaCoat', ['Second Roughness Weight', 'SecondRoughnessWeight']])
    const lines2 = pairs.map(([from, to]) => `wire(custom, ${py(from)}, slab, ${JSON.stringify(to)})`)
    if (ir.layers.sheen) lines2.push(`fuzz = add(unreal.MaterialExpressionConstant, 100, -420)\nfuzz.set_editor_property("r", 1.0)\nwire(fuzz, "", slab, ["Fuzz Amount", "FuzzAmount"])`)
    return lines2.join('\n')
  }
}

/** The end of every Unreal material script: a Material Instance of the material (and of its outline), which the live
 * link and Sequencer change, put on the objects selected in the level. Undo takes it off again. */
export function unrealApply(outline: boolean): string {
  return `
# ---- Material Instances, put on the objects selected in the level
def instance_of(parent, mi_name):
    mi_path = FOLDER + "/" + mi_name
    if unreal.EditorAssetLibrary.does_asset_exist(mi_path):
        mi = unreal.EditorAssetLibrary.load_asset(mi_path)
    else:
        mi = tools.create_asset(mi_name, FOLDER, unreal.MaterialInstanceConstant, unreal.MaterialInstanceConstantFactoryNew())
    L.set_material_instance_parent(mi, parent)
    L.update_material_instance(mi)
    unreal.EditorAssetLibrary.save_asset(mi_path)
    return mi

MI_NAME = "MI_" + (NAME[2:] if NAME.startswith("M_") else NAME)
mi = instance_of(mat, MI_NAME)
${outline ? 'omi = instance_of(om, MI_NAME + "_Outline")\n' : ''}picked = unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_selected_level_actors()
count = 0
with unreal.ScopedEditorTransaction("Inoscula " + MI_NAME):
    for actor in picked:
        for comp in actor.get_components_by_class(unreal.MeshComponent):
            for i in range(comp.get_num_materials()):
                comp.set_material(i, mi)
${outline ? '            comp.set_overlay_material(omi)  # the outline: the mesh drawn again around itself\n' : ''}            count += 1
if count:
    print("Inoscula: put " + MI_NAME + "${outline ? ' and its outline' : ''} on %d selected mesh%s" % (count, "" if count == 1 else "es"))
else:
    print("Inoscula: made " + FOLDER + "/" + MI_NAME + ". Select your objects in the level and run this again to put it on them${outline ? ', outline included' : ''}.")
`
}

// ------------------------------------------------------------------ Unity

/** Unity (URP): the outline as its own small shader, used as a second material on the mesh. */
export function toUnityOutline(ir: IR): string {
  if (!ir.outline) return ''
  const o = ir.outline
  const pOf = (a: typeof o.width) => (a.k === 'ref' ? ir.params.find((q) => 'p_' + q.id === a.id) : undefined)
  const wp = pOf(o.width), cp = pOf(o.color)
  const wv = wp ? (wp.default as number) : (o.width.v as number), cv = (cp ? cp.default : o.color.v) as number[]
  const bp = pOf(o.breakup), bv = bp ? (bp.default as number) : (o.breakup.v as number)
  const fp = pOf(o.offset), fv = fp ? (fp.default as number) : (o.offset.v as number)
  const op = pOf(o.boil), ov = op ? (op.default as number) : (o.boil.v as number)
  return `// ${ir.name}: outline. Save as ${ir.name.replace(/[^A-Za-z0-9]+/g, '')}Outline.shader, make a material with it and add it
// as a second material on the mesh renderer.
Shader "Inoscula/${ir.name} Outline" {
  Properties {
    _Width ("${wp?.label ?? 'Outline Width'}", Float) = ${num(wv)}
    _Color ("${cp?.label ?? 'Outline Color'}", Color) = (${cv.map(num).join(', ')}, 1)
    _Breakup ("${bp?.label ?? 'Outline Breakup'}", Range(0, 1)) = ${num(bv)}
    _Offset ("${fp?.label ?? 'Outline Offset'}", Float) = ${num(fv)}
    _Boil ("${op?.label ?? 'Outline Boil'}", Float) = ${num(ov)}
    _ObjectSize ("Object Size (meters)", Float) = 2
  }
  SubShader {
    Tags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" }
    Pass {
      Cull Front
      HLSLPROGRAM
      #pragma vertex vert
      #pragma fragment frag
      #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
      CBUFFER_START(UnityPerMaterial)
        float _Width;
        half4 _Color;
        float _Breakup;
        float _Offset;
        float _Boil;
        float _ObjectSize;
      CBUFFER_END
${noiseHelpers(LANG.hlsl).replace(/\binoscula_/g, 'InosculaOutline_')}
      struct A { float4 pos : POSITION; float3 nrm : NORMAL; };
      struct V { float4 pos : SV_POSITION; float3 obj : TEXCOORD0; float3 wn : TEXCOORD1; float3 wp : TEXCOORD2; };
      V vert(A i) {
        V o;
        o.obj = i.pos.xyz;
        float3 w = TransformObjectToWorld(i.pos.xyz) + normalize(TransformObjectToWorldNormal(i.nrm)) * (_Width + _Offset);
        o.pos = TransformWorldToHClip(w);
        o.wn = TransformObjectToWorldNormal(i.nrm);
        o.wp = w;
        return o;
      }
      half4 frag(V i) : SV_Target {
        // boil: the noise jumps to a new place this many times a second, so the line redraws like hand animation
        float seed = _Boil > 0.0 ? floor(_Time.y * _Boil) : 0.0;
        float3 q = i.obj.xzy + frac(seed * float3(0.1031, 0.1030, 0.0973)) * 37.0;
        // a broken, hand-inked line: the same noise as every tool (object space, Y up to Z up)
        clip(_Breakup > 0.0 ? InosculaOutline_noise(q, 30.0, 2.0, 0.5, 2.0) - _Breakup : 1.0);
        float face = abs(dot(normalize(i.wn), normalize(GetCameraPositionWS() - i.wp)));
        // offset: leave a gap between the surface and the line (measured as if the shape were round)
        float r = _ObjectSize * 0.5;
        float k = (r + _Offset) / (r + _Offset + _Width);
        clip(_Offset > 0.0 ? sqrt(max(1.0 - k * k, 0.0)) - face : 1.0);
${o.rings ? `        // loose offset lines: thin rings across the halo, each wobbling on its own
        clip(0.55 - face);
        clip(0.3 - frac(face * ${o.rings}.0 * 1.6 + InosculaOutline_noise(q, 3.0, 1.0, 0.5, 2.0) * 0.7));
` : ''}        return _Color;
      }
      ENDHLSL
    }
  }
}
`
}

export function toUnity(ir: IR): string {
  const fname = 'Inoscula_' + ir.name.replace(/[^A-Za-z0-9]+/g, '')
  const fn = hlslFunction(ir, fname + '_run')
  // Unity is Y up, left handed, meters. (x, y, z) becomes canonical (x, z, y).
  const prep: Record<string, string> = {
    g_uv: 'float3(UV.x, UV.y, 0.0)',
    g_obj: 'ObjectPosition.xzy', g_onrm: 'normalize(ObjectNormal.xzy)', g_wpos: 'WorldPosition.xzy',
    g_nrm: 'normalize(WorldNormal.xzy)', g_view: 'normalize(ViewDirection.xzy)', g_time: 'Time',
    g_light_dir: 'normalize(LightDirection.xzy)', g_light_color: 'LightColor', g_shape: 'VertexColor.xyz',
    g_osize: 'ObjectSize',
  }
  const pinName: Record<string, [string, string]> = {
    g_uv: ['float2', 'UV'], g_obj: ['float3', 'ObjectPosition'], g_onrm: ['float3', 'ObjectNormal'],
    g_wpos: ['float3', 'WorldPosition'], g_nrm: ['float3', 'WorldNormal'], g_view: ['float3', 'ViewDirection'],
    g_time: ['float', 'Time'], g_light_dir: ['float3', 'LightDirection'], g_light_color: ['float3', 'LightColor'],
    g_shape: ['float4', 'VertexColor'], g_osize: ['float', 'ObjectSize'],
  }
  // Shader Graph input names: PascalCase, which also keeps clear of HLSL words such as "line" or "point"
  const taken = new Set(['Color', 'Alpha', 'Smoothness', 'Metallic', 'Emission', 'NormalWS', ...Object.values(pinName).map((x) => x[1])])
  const pname = (id: string) => { let n = id.replace(/(^|_)([a-z])/g, (_m, _a, c) => c.toUpperCase()).replace(/^[a-z]/, (c) => c.toUpperCase()); if (taken.has(n)) n += 'Param'; taken.add(n); return n }
  const pnames = ir.params.map((p) => pname(p.id))
  const ins = fn.ins.map(([n]) => pinName[n])
  if (fn.bump) { if (!ins.some((x) => x[1] === 'WorldPosition')) ins.push(['float3', 'WorldPosition']); if (!ins.some((x) => x[1] === 'WorldNormal')) ins.push(['float3', 'WorldNormal']) }
  const sig = [...ins.map(([t, n]) => `${t} ${n}`), ...ir.params.map((p, i) => `${p.t === 'vec3' ? 'float3' : 'float'} ${pnames[i]}`)]
  const coat = ir.lit && Boolean(ir.layers.coat)
  const outs = ir.lit ? ['out float3 Color', 'out float Alpha', 'out float Smoothness', 'out float Metallic', 'out float3 Emission', 'out float3 NormalWS', ...(coat ? ['out float CoatMask', 'out float CoatSmoothness'] : [])] : ['out float3 Color', 'out float Alpha']
  if (ir.glass) outs.push('out float Glass', 'out float GlassIOR', 'out float GlassDispersion')
  const call = [...fn.ins.map(([n]) => prep[n]), ...pnames, ...(fn.bump ? ['WorldPosition', 'normalize(WorldNormal)'] : []), 'c', 'a', 'r', 'm', 'e', 'n', 'k', 'kr', 'sh', 'shr', 'ss', ...(ir.glass ? ['gl', 'gi', 'gd'] : [])]
  const guard = fname.toUpperCase() + '_INCLUDED'
  return `// ${ir.name}, made with Inoscula. Shader Graph: add a Custom Function node, Type: File, Source: this file,
// Name: ${fname}. Inputs, in order: ${sig.map((s) => s.split(' ')[1]).join(', ')}.
// Outputs: ${outs.map((s) => s.split(' ')[2]).join(', ')}.
${ir.lit ? `// Lit graph: wire Color to Base Color, Smoothness, Metallic and Emission to the same names${fn.bump ? ', and NormalWS to Normal\n// with Graph Settings > Fragment Normal Space set to World' : ''}.` : '// Unlit graph: wire Color to Base Color.'}
${ir.glass ? `// Glass: Glass, GlassIOR and GlassDispersion come out as numbers. Shader Graph builds the see-through part itself:
// set the graph's Surface Type to Transparent, turn on Opaque Texture in the URP asset, and mix a Scene Color node
// into the color by Glass. Inoscula does not wire that part in Unity yet.
` : ''}// Positions and directions in World space, object ones in Object space (Position and Normal Vector nodes).
// inoscula-graph: ${JSON.stringify(ir.source)}
#ifndef ${guard}
#define ${guard}
${fn.code.replace(/\binoscula_/g, fname + '_')}
void ${fname}_float(${[...sig, ...outs].join(', ')}) {
  float3 c; float a; float r; float m; float3 e; float3 n; float k; float kr; float3 sh; float shr; float ss;${ir.glass ? ' float gl; float gi; float gd;' : ''}
  ${fname}_run(${call.join(', ')});
  Color = c;
  Alpha = a;
${ir.lit ? '  Smoothness = 1.0 - r;\n  Metallic = m;\n  Emission = e;\n  NormalWS = n;\n' : ''}${coat ? '  CoatMask = k;\n  CoatSmoothness = 1.0 - kr;\n' : ''}${ir.glass ? '  Glass = gl;\n  GlassIOR = gi;\n  GlassDispersion = gd;\n' : ''}}
#endif
`
}

// ------------------------------------------------------------------ Unity, one drop-in shader

const srgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)
// ShaderLab attribute and label text: no quotes, commas or brackets
const plain = (s: string) => s.replace(/["(),\[\]]/g, ' ').replace(/\s+/g, ' ').trim()

/** A whole URP shader in one file: drop it in Assets, make a material from it, and every parameter is a slider in
 *  the Inspector. No Shader Graph. Lit looks go through URP's own lighting (shadows, extra lights, fog), and the
 *  outline, when the look has one, is a second pass of the same material. */
export function toUnityShader(ir: IR): string {
  const short = ir.name.replace(/[^A-Za-z0-9]+/g, '')
  const fname = 'Inoscula_' + short
  const fn = hlslFunction(ir, fname + '_run')
  // names Unity already uses for its own values
  const taken = new Set(['_Time', '_SinTime', '_CosTime', '_DeltaTime', '_ScreenParams', '_ProjectionParams', '_ZBufferParams', '_WorldSpaceCameraPos', '_MainLightPosition', '_MainLightColor', '_LightDirection', '_LightPosition', '_Surface', '_Cutoff', '_InosculaUnused'])
  const prop = (id: string) => { let n = '_' + id.replace(/(^|_)([a-z])/g, (_m, _a, c) => c.toUpperCase()).replace(/^[a-z]/, (c) => c.toUpperCase()); while (taken.has(n)) n += '_'; taken.add(n); return n }
  const pn = new Map(ir.params.map((p) => [p.id, prop(p.id)]))
  let group = ''
  const props = ir.params.map((p) => {
    const g = plain(p.group ?? '')
    const head = g && g !== group ? `[Header(${g})] ` : ''
    group = g || group
    const label = plain(p.label ?? p.id)
    const name = pn.get(p.id)!
    if (p.t === 'float') {
      const d = num(p.default as number)
      if (p.ui === 'toggle') return `    ${head}[ToggleUI] ${name} ("${label}", Float) = ${d}`
      if (p.ui === 'menu' && p.options?.length) return `    ${head}[Enum(${p.options.map((o, i) => `${plain(o) || 'Option ' + (i + 1)}, ${i}`).join(', ')})] ${name} ("${label}", Float) = ${d}`
      if (p.min !== undefined && p.max !== undefined) return `    ${head}${name} ("${label}", Range(${num(p.min)}, ${num(p.max)})) = ${d}`
      return `    ${head}${name} ("${label}", Float) = ${d}`
    }
    const v = p.default as number[]
    // Unity shows Color properties in sRGB and hands the shader linear values, like Godot's source_color
    if (p.type === 'color') return `    ${head}${name} ("${label}", Color) = (${v.map((c) => num(+srgb(c).toFixed(6))).join(', ')}, 1)`
    return `    ${head}${name} ("${label}", Vector) = (${v.map(num).join(', ')}, 0)`
  })
  const cbuf = ir.params.map((p) => `    ${p.t === 'float' ? 'float' : 'float4'} ${pn.get(p.id)};`)
  const pval = (id: string) => { const p = ir.params.find((q) => q.id === id)!; return p.t === 'float' ? pn.get(id)! : pn.get(id)! + '.xyz' }
  // Unity is Y up, left handed, meters. (x, y, z) becomes canonical (x, z, y), the same as the Shader Graph version.
  const prep: Record<string, string> = {
    g_uv: 'float3(i.uv.x, i.uv.y, 0.0)', g_obj: 'i.positionOS.xzy', g_onrm: 'normalize(i.normalOS.xzy)',
    g_wpos: 'i.positionWS.xzy', g_nrm: 'nrm.xzy', g_view: 'view.xzy', g_time: '_Time.y',
    g_light_dir: 'normalize(sun.direction.xzy)', g_light_color: 'sun.color', g_shape: 'i.color.xyz',
    g_osize: 'InosculaObjectSize()',
  }
  const call = [...fn.ins.map(([n]) => prep[n]), ...ir.params.map((p) => pval(p.id)), ...(fn.bump ? ['i.positionWS', 'nrm'] : []), 'c', 'a', 'r', 'm', 'e', 'n', 'k', 'kr', 'sh', 'shr', 'ss', ...(ir.glass ? ['gl', 'gi', 'gd'] : [])]
  const coat = ir.lit && Boolean(ir.layers.coat)
  const blend = !ir.cutout && Boolean(ir.alpha)
  const cull = ir.cutout ? 'Off' : 'Back'
  const tags = blend ? '"RenderType" = "Transparent" "Queue" = "Transparent"' : ir.cutout ? '"RenderType" = "TransparentCutout" "Queue" = "AlphaTest"' : '"RenderType" = "Opaque" "Queue" = "Geometry"'
  const evalBlock = `        float3 c; float a; float r; float m; float3 e; float3 n; float k; float kr; float3 sh; float shr; float ss;${ir.glass ? ' float gl; float gi; float gd;' : ''}
        ${fname}_run(${call.join(', ')});`
  // the outline: the mesh drawn again, pushed out along its normals, back faces only
  const o = ir.outline
  const oarg = (a: NonNullable<typeof o>['width']) => (a.k === 'ref' ? (() => { const p = ir.params.find((q) => 'p_' + q.id === a.id); return p ? pval(p.id) : num(0) })() : Array.isArray(a.v) ? `float3(${(a.v as number[]).map(num).join(', ')})` : num(a.v as number))
  const outlinePass = o ? `
    Pass {
      Name "InosculaOutline"
      Tags { "LightMode" = "SRPDefaultUnlit" }
      Cull Front
      HLSLPROGRAM
      #pragma target 3.5
      #pragma vertex OutlineVert
      #pragma fragment OutlineFrag
      #pragma multi_compile_fog
      #pragma multi_compile_instancing
      struct OA { float4 positionOS : POSITION; float3 normalOS : NORMAL; UNITY_VERTEX_INPUT_INSTANCE_ID };
      struct OV { float4 positionCS : SV_POSITION; float3 obj : TEXCOORD0; float3 wn : TEXCOORD1; float3 wp : TEXCOORD2; float fog : TEXCOORD3; UNITY_VERTEX_INPUT_INSTANCE_ID };
      OV OutlineVert(OA v) {
        OV o;
        UNITY_SETUP_INSTANCE_ID(v);
        UNITY_TRANSFER_INSTANCE_ID(v, o);
        float3 nw = normalize(TransformObjectToWorldNormal(v.normalOS));
        float3 w = TransformObjectToWorld(v.positionOS.xyz) + nw * ((${oarg(o.width)}) + (${oarg(o.offset)}));
        o.positionCS = TransformWorldToHClip(w);
        o.obj = v.positionOS.xyz;
        o.wn = nw;
        o.wp = w;
        o.fog = ComputeFogFactor(o.positionCS.z);
        return o;
      }
      half4 OutlineFrag(OV i) : SV_Target {
        UNITY_SETUP_INSTANCE_ID(i);
        float width = ${oarg(o.width)};
        float offset = ${oarg(o.offset)};
        float breakup = ${oarg(o.breakup)};
        float boil = ${oarg(o.boil)};
        clip(width > 0.0 ? 1.0 : -1.0);
        // boil: the noise jumps to a new place this many times a second, so the line redraws like hand animation
        float seed = boil > 0.0 ? floor(_Time.y * boil) : 0.0;
        float3 q = i.obj.xzy + frac(seed * float3(0.1031, 0.1030, 0.0973)) * 37.0;
        // a broken, hand-inked line: the same noise as every tool (object space, Y up to Z up)
        clip(breakup > 0.0 ? InosculaOutline_noise(q, 30.0, 2.0, 0.5, 2.0) - breakup : 1.0);
        float face = abs(dot(normalize(i.wn), normalize(GetCameraPositionWS() - i.wp)));
        // offset: leave a gap between the surface and the line (measured as if the shape were round)
        float rad = InosculaObjectSize() * 0.5;
        float kk = (rad + offset) / (rad + offset + width);
        clip(offset > 0.0 ? sqrt(max(1.0 - kk * kk, 0.0)) - face : 1.0);
${o.rings ? `        // loose offset lines: thin rings across the halo, each wobbling on its own
        clip(0.55 - face);
        clip(0.3 - frac(face * ${o.rings}.0 * 1.6 + InosculaOutline_noise(q, 3.0, 1.0, 0.5, 2.0) * 0.7));
` : ''}        return half4(MixFog(${oarg(o.color)}, i.fog), 1.0);
      }
      ENDHLSL
    }
` : ''
  // passes that only need the shape: shadows and the depth URP uses for SSAO and depth priming
  const shapePass = (name: string, mode: string, body: string, extra = '') => `
    Pass {
      Name "${name}"
      Tags { "LightMode" = "${mode}" }
      ZWrite On
      ${mode === 'ShadowCaster' ? 'ZTest LEqual\n      ColorMask 0\n      ' : mode === 'DepthOnly' ? 'ColorMask R\n      ' : ''}Cull ${cull}
      HLSLPROGRAM
      #pragma target 3.5
      #pragma vertex ShapeVert
      #pragma fragment ShapeFrag
      #pragma multi_compile_instancing
${extra}${body}
      ENDHLSL
    }
`
  const shapeCommon = (pos: string) => `      struct SA { float4 positionOS : POSITION; float3 normalOS : NORMAL; float2 uv : TEXCOORD0; float4 color : COLOR; UNITY_VERTEX_INPUT_INSTANCE_ID };
      struct SV { float4 positionCS : SV_POSITION; float3 normalWS : TEXCOORD0;${ir.cutout ? ' float3 positionWS : TEXCOORD1; float3 positionOS : TEXCOORD2; float3 normalOS : TEXCOORD3; float2 uv : TEXCOORD4; float4 color : COLOR;' : ''} UNITY_VERTEX_INPUT_INSTANCE_ID };
      SV ShapeVert(SA v) {
        SV o;
        UNITY_SETUP_INSTANCE_ID(v);
        UNITY_TRANSFER_INSTANCE_ID(v, o);
        float3 positionWS = TransformObjectToWorld(v.positionOS.xyz);
        o.normalWS = TransformObjectToWorldNormal(v.normalOS);
${pos}${ir.cutout ? '        o.positionWS = positionWS; o.positionOS = v.positionOS.xyz; o.normalOS = v.normalOS; o.uv = v.uv; o.color = v.color;\n' : ''}        return o;
      }
${ir.cutout ? `      // cut out: the same holes as the color pass
      void ShapeCut(SV i) {
        float3 nrm = normalize(i.normalWS);
        float3 view = GetWorldSpaceNormalizeViewDir(i.positionWS);
        Light sun = GetMainLight();
${evalBlock}
        clip(a - 0.5);
      }
` : '      void ShapeCut(SV i) {}\n'}`
  const shadow = shapePass('ShadowCaster', 'ShadowCaster', `${shapeCommon(`#if _CASTING_PUNCTUAL_LIGHT_SHADOW
        float3 toLight = normalize(_LightPosition - positionWS);
#else
        float3 toLight = _LightDirection;
#endif
        o.positionCS = ApplyShadowClamping(TransformWorldToHClip(ApplyShadowBias(positionWS, o.normalWS, toLight)));
`)}      half4 ShapeFrag(SV i) : SV_Target { UNITY_SETUP_INSTANCE_ID(i); ShapeCut(i); return 0; }`, `      #pragma multi_compile_vertex _ _CASTING_PUNCTUAL_LIGHT_SHADOW
      #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Shadows.hlsl"
      float3 _LightDirection;
      float3 _LightPosition;
`)
  const depth = shapePass('DepthOnly', 'DepthOnly', `${shapeCommon('        o.positionCS = TransformWorldToHClip(positionWS);\n')}      half ShapeFrag(SV i) : SV_Target { UNITY_SETUP_INSTANCE_ID(i); ShapeCut(i); return i.positionCS.z; }`)
  const depthNormals = shapePass('DepthNormalsOnly', 'DepthNormalsOnly', `${shapeCommon('        o.positionCS = TransformWorldToHClip(positionWS);\n')}      half4 ShapeFrag(SV i) : SV_Target {
        UNITY_SETUP_INSTANCE_ID(i);
        ShapeCut(i);
#if defined(_GBUFFER_NORMALS_OCT)
        float2 oct = saturate(PackNormalOctQuadEncode(normalize(i.normalWS)) * 0.5 + 0.5);
        return half4(PackFloat2To888(oct), 0.0);
#else
        return half4(NormalizeNormalPerPixel(i.normalWS), 0.0);
#endif
      }`, '      #pragma multi_compile_fragment _ _GBUFFER_NORMALS_OCT\n')
  return `// ${ir.name}, made with Inoscula. A complete Unity shader (URP): put this file in Assets, right-click it,
// Create > Material, and drag the material onto your model. Every parameter is a slider on the material.
// The light comes from the scene's main Directional Light.${o ? ' The outline is part of the same material.' : ''}${ir.glass ? '\n// Glass is not see-through in this version: the surface shows its color only.' : ''}
// inoscula-graph: ${JSON.stringify(ir.source)}
Shader "Inoscula/${plain(ir.name)}" {
  Properties {
${props.join('\n')}
  }
  SubShader {
    Tags { ${tags} "RenderPipeline" = "UniversalPipeline" }
    HLSLINCLUDE
    #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
    #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
    CBUFFER_START(UnityPerMaterial)
${cbuf.join('\n') || '    float _InosculaUnused;'}
    CBUFFER_END
    // the object's size in meters: the diagonal of its bounds, the same measure Blender and Godot use
    float InosculaObjectSize() {
      float d = length(unity_RendererBounds_Max.xyz - unity_RendererBounds_Min.xyz);
      return d > 0.0 ? d : 2.0;
    }
${fn.code.replace(/\binoscula_/g, fname + '_')}
${o ? noiseHelpers(LANG.hlsl).replace(/\binoscula_/g, 'InosculaOutline_') + '\n' : ''}    ENDHLSL

    Pass {
      Name "InosculaForward"
      Tags { "LightMode" = "UniversalForwardOnly" }
      Cull ${cull}
${blend ? '      Blend SrcAlpha OneMinusSrcAlpha\n      ZWrite Off\n' : '      ZWrite On\n'}      HLSLPROGRAM
      #pragma target 3.5
      #pragma vertex InosculaVert
      #pragma fragment InosculaFrag
${ir.lit ? `      #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE _MAIN_LIGHT_SHADOWS_SCREEN
      #pragma multi_compile _ _ADDITIONAL_LIGHTS_VERTEX _ADDITIONAL_LIGHTS
      #pragma multi_compile_fragment _ _ADDITIONAL_LIGHT_SHADOWS
      #pragma multi_compile_fragment _ _SHADOWS_SOFT _SHADOWS_SOFT_LOW _SHADOWS_SOFT_MEDIUM _SHADOWS_SOFT_HIGH
      #pragma multi_compile_fragment _ _SCREEN_SPACE_OCCLUSION
      #pragma multi_compile _ _FORWARD_PLUS
      #pragma multi_compile _ _CLUSTER_LIGHT_LOOP
${coat ? '      #define _CLEARCOAT 1\n' : ''}` : ''}      #pragma multi_compile_fog
      #pragma multi_compile_instancing
      struct Attributes { float4 positionOS : POSITION; float3 normalOS : NORMAL; float2 uv : TEXCOORD0; float4 color : COLOR; UNITY_VERTEX_INPUT_INSTANCE_ID };
      struct Varyings {
        float4 positionCS : SV_POSITION;
        float3 positionWS : TEXCOORD0;
        float3 normalWS : TEXCOORD1;
        float3 positionOS : TEXCOORD2;
        float3 normalOS : TEXCOORD3;
        float2 uv : TEXCOORD4;
        float fog : TEXCOORD5;
        float4 color : COLOR;
        UNITY_VERTEX_INPUT_INSTANCE_ID
      };
      Varyings InosculaVert(Attributes v) {
        Varyings o;
        UNITY_SETUP_INSTANCE_ID(v);
        UNITY_TRANSFER_INSTANCE_ID(v, o);
        o.positionWS = TransformObjectToWorld(v.positionOS.xyz);
        o.normalWS = TransformObjectToWorldNormal(v.normalOS);
        o.positionCS = TransformWorldToHClip(o.positionWS);
        o.positionOS = v.positionOS.xyz;
        o.normalOS = v.normalOS;
        o.uv = v.uv;
        o.color = v.color;
        o.fog = ComputeFogFactor(o.positionCS.z);
        return o;
      }
      half4 InosculaFrag(Varyings i${cull === 'Off' ? ', bool front : SV_IsFrontFace' : ''}) : SV_Target {
        UNITY_SETUP_INSTANCE_ID(i);
        float3 nrm = normalize(i.normalWS)${cull === 'Off' ? ' * (front ? 1.0 : -1.0)' : ''};
        float3 view = GetWorldSpaceNormalizeViewDir(i.positionWS);
        float4 shadowCoord = TransformWorldToShadowCoord(i.positionWS);
        Light sun = GetMainLight(shadowCoord);
${evalBlock}
${ir.cutout ? '        clip(a - 0.5);\n' : ''}${ir.lit ? `        InputData d = (InputData)0;
        d.positionWS = i.positionWS;
        d.positionCS = i.positionCS;
        d.normalWS = ${fn.bump ? 'normalize(n)' : 'nrm'};
        d.viewDirectionWS = view;
        d.shadowCoord = shadowCoord;
        d.fogCoord = i.fog;
        d.bakedGI = SampleSH(d.normalWS);
        d.normalizedScreenSpaceUV = GetNormalizedScreenSpaceUV(i.positionCS);
        d.shadowMask = half4(1.0, 1.0, 1.0, 1.0);
        SurfaceData s = (SurfaceData)0;
        s.albedo = c;
        s.alpha = ${blend ? 'saturate(a)' : '1.0'};
        s.metallic = m;
        s.smoothness = 1.0 - r;
        s.emission = e;
        s.occlusion = 1.0;
        s.normalTS = float3(0.0, 0.0, 1.0);${coat ? '\n        s.clearCoatMask = k;\n        s.clearCoatSmoothness = 1.0 - kr;' : ''}
        half4 col = UniversalFragmentPBR(d, s);
        col.rgb = MixFog(col.rgb, i.fog);
        return col;` : `        return half4(MixFog(c, i.fog), ${blend ? 'saturate(a)' : '1.0'});`}
      }
      ENDHLSL
    }
${outlinePass}${shadow}${depth}${depthNormals}  }
  FallBack "Hidden/Universal Render Pipeline/FallbackError"
}
`
}
