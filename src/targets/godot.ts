// Godot 4 target: a .gdshader whose parameters show up in the Inspector, plus a small light bridge script.
import { body, helpers, LANG, noiseHelpers, num } from '../code.ts'
import type { IR } from '../spec.ts'

export interface GodotOpts {
  /** Godot meshes imported from glTF keep UVs with the origin top left. Default true. */
  flipV?: boolean
  /** Draw the mesh flattened into UV space (parity test only). */
  bakeUV?: boolean
}

// sRGB encode: Godot shows source_color uniforms in sRGB and converts them to linear for the shader, so the
// default we write must be the sRGB form of the linear colour stored in the graph.
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)

export function toGodot(ir: IR, o: GodotOpts = {}): string {
  const flip = o.flipV ?? true
  const uni = ir.params.map((p) => {
    if (p.t === 'float') {
      const hint = p.min !== undefined && p.max !== undefined ? ` : hint_range(${num(p.min)}, ${num(p.max)})` : ''
      return `uniform float p_${p.id}${hint} = ${num(p.default as number)};`
    }
    const v = p.default as number[]
    if (p.type === 'color') return `uniform vec3 p_${p.id} : source_color = vec3(${v.map((c) => num(+toSrgb(c).toFixed(6))).join(', ')});`
    return `uniform vec3 p_${p.id} = vec3(${v.map(num).join(', ')});`
  })
  const blend = ir.cutout ? 'depth_draw_opaque' : ir.alpha ? 'blend_mix, depth_draw_opaque' : 'blend_mix'
  return `// ${ir.name}
// Made with Inoscula. Parameters are editable in the Inspector. Add inoscula_light_bridge.gd to the scene to feed the
// main light into inoscula_light_dir and inoscula_light_color.
// inoscula-graph: ${JSON.stringify(ir.source)}
shader_type spatial;
render_mode ${ir.lit && !o.bakeUV ? '' : 'unshaded, '}${blend}, ${o.bakeUV || ir.cutout ? 'cull_disabled' : 'cull_back'};

${uni.join('\n')}
uniform vec3 inoscula_light_dir = vec3(0.4, 0.8, 0.45);
uniform vec3 inoscula_light_color = vec3(1.0, 1.0, 1.0);
${ir.uses.has('object_size') && !o.bakeUV ? 'instance uniform float inoscula_object_size = 2.0; // the object\'s size in metres; inoscula_light_bridge.gd sets it\n' : ''}
varying vec3 g_vobj;
varying vec3 g_vonrm;
varying vec3 g_vwpos;
varying vec3 g_vwnrm;
varying vec3 g_vshape;

vec3 inoscula_canon(vec3 p) { return vec3(p.x, -p.z, p.y); }
${helpers(ir, LANG.godot)}
void vertex() {
  g_vobj = VERTEX;
  g_vonrm = NORMAL;
  g_vwpos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
  g_vwnrm = (MODEL_MATRIX * vec4(NORMAL, 0.0)).xyz;
  g_vshape = COLOR.rgb; // shape data from Inoscula Studio's Prepare model: red curvature, green occlusion${o.bakeUV ? `
  POSITION = vec4(UV.x * 2.0 - 1.0, ${flip ? '(1.0 - UV.y)' : 'UV.y'} * 2.0 - 1.0, 0.5, 1.0);` : ''}
}

void fragment() {
  vec3 g_uv = vec3(UV.x, ${flip ? '1.0 - UV.y' : 'UV.y'}, 0.0);
  vec3 g_obj = inoscula_canon(g_vobj);
  vec3 g_onrm = inoscula_canon(normalize(g_vonrm));
  vec3 g_wpos = inoscula_canon(g_vwpos);
  vec3 g_nrm = inoscula_canon(normalize(g_vwnrm));
  vec3 g_view = ${o.bakeUV ? 'g_nrm' : 'inoscula_canon(normalize(CAMERA_POSITION_WORLD - g_vwpos))'};
  float g_time = ${o.bakeUV ? '0.0' : 'TIME'};
  vec3 g_light_dir = inoscula_canon(normalize(inoscula_light_dir));
  vec3 g_light_color = inoscula_light_color;
  float g_curv = mix(0.5, g_vshape.x, inoscula_has_shape(g_vshape));
  float g_osize = ${ir.uses.has('object_size') && !o.bakeUV ? 'inoscula_object_size' : '2.0'};
  float g_occ = mix(1.0, g_vshape.y, inoscula_has_shape(g_vshape));
${body(ir, LANG.godot)}
  ALBEDO = g_out_color;
${ir.alpha ? '  ALPHA = g_out_alpha;\n' : ''}${ir.cutout && !o.bakeUV ? '  ALPHA_SCISSOR_THRESHOLD = 0.5;\n' : ''}${ir.lit && !o.bakeUV ? `  ROUGHNESS = clamp(g_out_rough, 0.0, 1.0);
  METALLIC = clamp(g_out_metal, 0.0, 1.0);
  EMISSION = g_out_emit;
${ir.bump ? '  NORMAL = inoscula_bump(VERTEX, NORMAL, g_out_bump);\n' : ''}${ir.layers.coat ? '  CLEARCOAT = clamp(g_out_coat, 0.0, 1.0);\n  CLEARCOAT_ROUGHNESS = clamp(g_out_coat_rough, 0.0, 1.0);\n' : ''}${ir.layers.sheen ? '  RIM = clamp(g_out_sheen, 0.0, 1.0); // Godot has no sheen layer; rim lighting is its closest\n  RIM_TINT = 0.5;\n' : ''}${ir.layers.subsurface ? '  SSS_STRENGTH = clamp(g_out_sss, 0.0, 1.0);\n' : ''}` : ''}
}
`
}

/** The outline pass: a second shader to set as the material's Next Pass. Empty when the shader has none. */
export function toGodotOutline(ir: IR): string {
  if (!ir.outline) return ''
  const val = (a: any, kind: 'float' | 'vec3') => {
    if (a.k === 'ref') {
      const p = ir.params.find((q) => 'p_' + q.id === a.id)!
      const d = p.default
      return kind === 'float' ? `uniform float ${a.id} = ${num(d as number)};` : `uniform vec3 ${a.id} : source_color = vec3(${(d as number[]).map((c) => num(+toSrgb(c).toFixed(6))).join(', ')});`
    }
    return kind === 'float' ? `const float inoscula_ow = ${num(a.v)};` : `const vec3 inoscula_oc = vec3(${(a.v as number[]).map(num).join(', ')});`
  }
  const w = ir.outline.width, c = ir.outline.color, b = ir.outline.breakup
  const bv = b.k === 'ref' ? `uniform float ${b.id} = ${num(ir.params.find((q) => 'p_' + q.id === b.id)!.default as number)};` : `const float inoscula_ob = ${num(b.v as number)};`
  return `// ${ir.name}: outline pass. Set this as the Next Pass of the ${ir.name} material.
// inoscula-graph: ${JSON.stringify(ir.source)}
shader_type spatial;
render_mode unshaded, cull_front;

${val(w, 'float')}
${val(c, 'vec3')}
${bv}
varying vec3 g_vobj;

vec3 inoscula_canon(vec3 p) { return vec3(p.x, -p.z, p.y); }
${noiseHelpers(LANG.godot)}
void vertex() {
  g_vobj = VERTEX;
  VERTEX += normalize(NORMAL) * ${w.k === 'ref' ? w.id : 'inoscula_ow'} / max(length((MODEL_MATRIX * vec4(normalize(NORMAL), 0.0)).xyz), 1e-6);
}

void fragment() {
  float bk = ${b.k === 'ref' ? b.id : 'inoscula_ob'};
  if (bk > 0.0 && inoscula_noise(inoscula_canon(g_vobj), 30.0, 2.0, 0.5, 2.0) < bk) discard;
${ir.outline.rings ? `  // loose offset lines: thin rings across the halo, each wobbling on its own
  if (abs(dot(normalize(NORMAL), normalize(VIEW))) > 0.55) discard;
  if (fract(abs(dot(normalize(NORMAL), normalize(VIEW))) * ${ir.outline.rings}.0 * 1.6 + inoscula_noise(inoscula_canon(g_vobj), 3.0, 1.0, 0.5, 2.0) * 0.7) > 0.3) discard;
` : ''}  ALBEDO = ${c.k === 'ref' ? c.id : 'inoscula_oc'};
}
`
}

export const GODOT_LIGHT_BRIDGE = `# Inoscula light bridge for Godot 4. Add this script to any node, point "light" at your main DirectionalLight3D,
# and every Inoscula material below "root" follows it, in the editor and in the game.
@tool
extends Node

@export var light: DirectionalLight3D
@export var root: Node

func _process(_delta: float) -> void:
	if light == null:
		return
	var dir := light.global_transform.basis.z.normalized()
	var col := light.light_color.srgb_to_linear() * light.light_energy
	var start := root
	if start == null:
		start = get_tree().edited_scene_root if Engine.is_editor_hint() else get_tree().current_scene
	_apply(start, dir, Vector3(col.r, col.g, col.b))

func _apply(n: Node, dir: Vector3, col: Vector3) -> void:
	if n == null:
		return
	if n is GeometryInstance3D:
		var mats: Array = []
		if n.material_override != null:
			mats.append(n.material_override)
		if n is MeshInstance3D and n.mesh != null:
			for i in n.mesh.get_surface_count():
				var m = n.get_active_material(i)
				if m != null:
					mats.append(m)
		for m in mats:
			if m is ShaderMaterial and m.shader != null and m.shader.code.find("inoscula_light_dir") != -1:
				m.set_shader_parameter("inoscula_light_dir", dir)
				m.set_shader_parameter("inoscula_light_color", col)
			if m is ShaderMaterial and m.shader != null and m.shader.code.find("inoscula_object_size") != -1:
				var box: AABB = n.get_aabb()
				var s: Vector3 = n.global_transform.basis.get_scale()
				n.set_instance_shader_parameter("inoscula_object_size", (box.size * s).length())
	for c in n.get_children():
		_apply(c, dir, col)
`
