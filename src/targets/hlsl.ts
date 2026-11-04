// HLSL targets: Unreal (an editor Python script that builds the material, parameters and all) and Unity
// (a Custom Function file for Shader Graph). Both share one HLSL function so they compute the same thing.
import { body, helpers, LANG, noiseHelpers, num } from '../code.ts'
import type { IR } from '../spec.ts'

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
  o_sss = saturate(g_out_sss);
}`,
  }
}

// ------------------------------------------------------------------ Unreal

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
  const fn = hlslFunction(ir, 'run', 100) // bump heights are metres; Unreal works in centimetres
  const name = 'M_' + ir.name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')
  // Unreal is Z up, left handed, centimetres. Canonical = (x, -y, z) and metres.
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
  const call = [...fn.ins.map(([n]) => prep[n]), ...ir.params.map((p) => (p.t === 'vec3' ? `P_${p.id}.xyz` : `P_${p.id}`)), ...(fn.bump ? ['WPos', 'normalize(WNrm)'] : []), 'c', 'a', 'r', 'm', 'e', 'n', 'k', 'kr', 'sh', 'shr', 'ss']
  const lit = ir.lit
  const asFn = o.as === 'function'
  const substrate = lit && Boolean(o.substrate)
  // extra outputs of the Custom node: [name, type, what it carries]
  const extra: [string, string, string][] = lit ? [
    ['InosculaRoughness', 'CMOT_FLOAT1', 'r'], ['InosculaMetallic', 'CMOT_FLOAT1', 'm'], ['InosculaEmissive', 'CMOT_FLOAT3', 'e'], ['InosculaNormal', 'CMOT_FLOAT3', 'n'],
    ['InosculaCoat', 'CMOT_FLOAT1', 'k'], ['InosculaCoatRoughness', 'CMOT_FLOAT1', 'kr'], ['InosculaSheen', 'CMOT_FLOAT3', 'sh'], ['InosculaSheenRoughness', 'CMOT_FLOAT1', 'shr'], ['InosculaSubsurface', 'CMOT_FLOAT1', 'ss'],
    // Substrate wants albedo and F0 rather than base colour and metallic
    ['InosculaDiffuseAlbedo', 'CMOT_FLOAT3', 'c * (1.0 - m)'], ['InosculaF0', 'CMOT_FLOAT3', 'lerp((float3)0.04, c, m)'],
  ] : []
  const custom = `struct InosculaFn {
${fn.code}
};
InosculaFn G;
float3 c; float a; float r; float m; float3 e; float3 n; float k; float kr; float3 sh; float shr; float ss;
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
      // the object's size: its bounds radius, doubled (centimetres; the shader turns it into metres)
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
  const fnOuts = asFn ? [...routes.map(([, to]) => to), ...(lit ? ['Coat', 'CoatRoughness', 'Sheen', 'SheenRoughness', 'Subsurface', 'DiffuseAlbedo', 'F0'] : [])] : []
  const fnFrom: Record<string, string> = { Coat: 'InosculaCoat', CoatRoughness: 'InosculaCoatRoughness', Sheen: 'InosculaSheen', SheenRoughness: 'InosculaSheenRoughness', Subsurface: 'InosculaSubsurface', DiffuseAlbedo: 'InosculaDiffuseAlbedo', F0: 'InosculaF0' }

  return `# ${ir.name}, made with Inoscula.
# Run inside the Unreal Editor: Tools > Execute Python Script (needs the Python Editor Script Plugin).
# It builds ${o.folder ?? '/Game/Inoscula'}/${asFn ? 'MF_' + name.slice(2) : name}: one Custom node holding the shader, wired to real
# parameters, so everything stays editable${asFn ? ' wherever you use the function' : ' in a Material Instance'}.${asFn ? `
# Material Function: drag it into any material, Substrate graph or layer stack. One output per channel.` : ''}${lit ? `
# Lit: Unreal lights it itself (Lumen, shadows, reflections).` : ''}${substrate ? `
# Substrate: the material ends in a Substrate Slab (needs Substrate turned on in Project Settings).` : ''}${ir.uses.has('curvature') || ir.uses.has('occlusion') ? `
# Shape data: import the model that Inoscula Studio's Prepare model saved, with vertex colours kept.` : ''}
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
    mat.set_editor_property("blend_mode", unreal.BlendMode.${ir.cutout ? 'BLEND_MASKED' : ir.alpha ? 'BLEND_TRANSLUCENT' : 'BLEND_OPAQUE'})${ir.cutout ? '\n    mat.set_editor_property("two_sided", True)' : ''}
${lit && fn.bump ? '    mat.set_editor_property("tangent_space_normal", False)  # the Custom node gives a world space normal\n' : ''}
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
custom.set_editor_property("inputs", [unreal.CustomInput(input_name=n) for n, _ in pins])
${extra.length ? `custom.set_editor_property("additional_outputs", [
${extra.map(([nm, ty]) => `    unreal.CustomOutput(output_name=${py(nm)}, output_type=unreal.CustomMaterialOutputType.${ty}),`).join('\n')}
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
${routes.map(([from, to]) => `e, pin = src(${py(from)})\nL.connect_material_property(e, pin, unreal.MaterialProperty.${prop[to]})`).join('\n')}
L.layout_material_expressions(mat)
L.recompile_material(mat)`}

# keep the Inoscula graph on the asset, so it can travel back out with any changes
unreal.EditorAssetLibrary.set_metadata_tag(mat, "inoscula", ${py(o.graphJson ?? JSON.stringify(ir.source))})
unreal.EditorAssetLibrary.save_asset(path)
print("Inoscula: built " + path)
${ir.outline ? unrealOutline() : ''}`

  // The outline as an Overlay Material: the mesh drawn again, pushed out along its normals, showing only its
  // inside faces. Set it in the Static Mesh component's Overlay Material slot (Unreal 5.1 and later).
  function unrealOutline() {
    const o = ir.outline!
    const pOf = (a: typeof o.width) => (a.k === 'ref' ? ir.params.find((q) => 'p_' + q.id === a.id) : undefined)
    const wp = pOf(o.width), cp = pOf(o.color)
    const wv = wp ? (wp.default as number) : (o.width.v as number), cv = (cp ? cp.default : o.color.v) as number[]
    const bp = pOf(o.breakup), bv = bp ? (bp.default as number) : (o.breakup.v as number)
    const maskCode = `struct InosculaOutline {\n${noiseHelpers(LANG.hlsl)}\n};\nInosculaOutline G;\nif (Sign >= 0.0) return 0.0;\nif (Breakup > 0.0 && G.inoscula_noise(float3(P.x, -P.y, P.z) * 0.01, 30.0, 2.0, 0.5, 2.0) < Breakup) return 0.0;\n${o.rings ? `if (abs(dot(normalize(N), normalize(C))) > 0.55) return 0.0;\nif (frac(abs(dot(normalize(N), normalize(C))) * ${o.rings}.0 * 1.6 + G.inoscula_noise(float3(P.x, -P.y, P.z) * 0.01, 3.0, 1.0, 0.5, 2.0) * 0.7) > 0.3) return 0.0;\n` : ''}return 1.0;`
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
ocm = oadd(unreal.MaterialExpressionMultiply, -500, 0)
ocm.set_editor_property("const_b", 100.0)  # metres to centimetres
L.connect_material_expressions(ow, "", ocm, "A")
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
omask.set_editor_property("inputs", [unreal.CustomInput(input_name="Sign"), unreal.CustomInput(input_name="P"), unreal.CustomInput(input_name="Breakup"), unreal.CustomInput(input_name="N"), unreal.CustomInput(input_name="C")])
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
L.connect_material_property(omask, "", unreal.MaterialProperty.MP_OPACITY_MASK)
L.layout_material_expressions(om)
L.recompile_material(om)
unreal.EditorAssetLibrary.save_asset(opath)
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

// ------------------------------------------------------------------ Unity

/** Unity (URP): the outline as its own small shader, used as a second material on the mesh. */
export function toUnityOutline(ir: IR): string {
  if (!ir.outline) return ''
  const o = ir.outline
  const pOf = (a: typeof o.width) => (a.k === 'ref' ? ir.params.find((q) => 'p_' + q.id === a.id) : undefined)
  const wp = pOf(o.width), cp = pOf(o.color)
  const wv = wp ? (wp.default as number) : (o.width.v as number), cv = (cp ? cp.default : o.color.v) as number[]
  const bp = pOf(o.breakup), bv = bp ? (bp.default as number) : (o.breakup.v as number)
  return `// ${ir.name}: outline. Save as ${ir.name.replace(/[^A-Za-z0-9]+/g, '')}Outline.shader, make a material with it and add it
// as a second material on the mesh renderer.
Shader "Inoscula/${ir.name} Outline" {
  Properties {
    _Width ("${wp?.label ?? 'Outline Width'}", Float) = ${num(wv)}
    _Color ("${cp?.label ?? 'Outline Color'}", Color) = (${cv.map(num).join(', ')}, 1)
    _Breakup ("${bp?.label ?? 'Outline Breakup'}", Range(0, 1)) = ${num(bv)}
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
      CBUFFER_END
${noiseHelpers(LANG.hlsl).replace(/\binoscula_/g, 'InosculaOutline_')}
      struct A { float4 pos : POSITION; float3 nrm : NORMAL; };
      struct V { float4 pos : SV_POSITION; float3 obj : TEXCOORD0; float3 wn : TEXCOORD1; float3 wp : TEXCOORD2; };
      V vert(A i) {
        V o;
        o.obj = i.pos.xyz;
        float3 w = TransformObjectToWorld(i.pos.xyz) + normalize(TransformObjectToWorldNormal(i.nrm)) * _Width;
        o.pos = TransformWorldToHClip(w);
        o.wn = TransformObjectToWorldNormal(i.nrm);
        o.wp = w;
        return o;
      }
      half4 frag(V i) : SV_Target {
        // a broken, hand-inked line: the same noise as every tool (object space, Y up to Z up)
        clip(_Breakup > 0.0 ? InosculaOutline_noise(i.obj.xzy, 30.0, 2.0, 0.5, 2.0) - _Breakup : 1.0);
${o.rings ? `        // loose offset lines: thin rings across the halo, each wobbling on its own
        clip(0.55 - abs(dot(normalize(i.wn), normalize(GetCameraPositionWS() - i.wp))));
        clip(0.3 - frac(abs(dot(normalize(i.wn), normalize(GetCameraPositionWS() - i.wp))) * ${o.rings}.0 * 1.6 + InosculaOutline_noise(i.obj.xzy, 3.0, 1.0, 0.5, 2.0) * 0.7));
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
  // Unity is Y up, left handed, metres. (x, y, z) becomes canonical (x, z, y).
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
  const call = [...fn.ins.map(([n]) => prep[n]), ...pnames, ...(fn.bump ? ['WorldPosition', 'normalize(WorldNormal)'] : []), 'c', 'a', 'r', 'm', 'e', 'n', 'k', 'kr', 'sh', 'shr', 'ss']
  const guard = fname.toUpperCase() + '_INCLUDED'
  return `// ${ir.name}, made with Inoscula. Shader Graph: add a Custom Function node, Type: File, Source: this file,
// Name: ${fname}. Inputs, in order: ${sig.map((s) => s.split(' ')[1]).join(', ')}.
// Outputs: ${outs.map((s) => s.split(' ')[2]).join(', ')}.
${ir.lit ? `// Lit graph: wire Color to Base Color, Smoothness, Metallic and Emission to the same names${fn.bump ? ', and NormalWS to Normal\n// with Graph Settings > Fragment Normal Space set to World' : ''}.` : '// Unlit graph: wire Color to Base Color.'}
// Positions and directions in World space, object ones in Object space (Position and Normal Vector nodes).
// inoscula-graph: ${JSON.stringify(ir.source)}
#ifndef ${guard}
#define ${guard}
${fn.code.replace(/\binoscula_/g, fname + '_')}
void ${fname}_float(${[...sig, ...outs].join(', ')}) {
  float3 c; float a; float r; float m; float3 e; float3 n; float k; float kr; float3 sh; float shr; float ss;
  ${fname}_run(${call.join(', ')});
  Color = c;
  Alpha = a;
${ir.lit ? '  Smoothness = 1.0 - r;\n  Metallic = m;\n  Emission = e;\n  NormalWS = n;\n' : ''}${coat ? '  CoatMask = k;\n  CoatSmoothness = 1.0 - kr;\n' : ''}}
#endif
`
}
