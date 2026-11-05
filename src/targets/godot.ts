// Godot 4 target: a .gdshader whose parameters show up in the Inspector, plus a small light bridge script.
import { body, helpers, LANG, noiseHelpers, num } from '../code.ts'
import { paramDesc, type IR } from '../spec.ts'

export interface GodotOpts {
  /** Godot meshes imported from glTF keep UVs with the origin top left. Default true. */
  flipV?: boolean
  /** Draw the mesh flattened into UV space (parity test only). */
  bakeUV?: boolean
}

// sRGB encode: Godot shows source_color uniforms in sRGB and converts them to linear for the shader, so the
// default we write must be the sRGB form of the linear color stored in the graph.
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)

export function toGodot(ir: IR, o: GodotOpts = {}): string {
  const flip = o.flipV ?? true
  let group = ''
  const uni = ir.params.map((p) => {
    // sections in the Inspector: group_uniforms opens one, a bare group_uniforms closes it
    const g = (p.group ?? '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
    const open = g !== group ? (group ? 'group_uniforms;\n' : '') + (g ? `group_uniforms ${g};\n` : '') : ''
    group = g
    const tip = paramDesc(p) ? ` // ${paramDesc(p)}` : ''
    return open + one(p) + tip
  })
  if (group) uni.push('group_uniforms;')
  function one(p: (typeof ir.params)[number]) {
    if (p.t === 'float') {
      const hint = p.min !== undefined && p.max !== undefined ? ` : hint_range(${num(p.min)}, ${num(p.max)}${p.step ? ', ' + num(p.step) : ''})` : ''
      return `uniform float p_${p.id}${hint} = ${num(p.default as number)};`
    }
    const v = p.default as number[]
    if (p.type === 'color') return `uniform vec3 p_${p.id} : source_color = vec3(${v.map((c) => num(+toSrgb(c).toFixed(6))).join(', ')});`
    return `uniform vec3 p_${p.id} = vec3(${v.map(num).join(', ')});`
  }
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
${ir.glass && !o.bakeUV ? 'uniform sampler2D inoscula_screen : hint_screen_texture, filter_linear_mipmap; // what is behind, for the glass\n' : ''}${ir.uses.has('object_size') && !o.bakeUV ? 'instance uniform float inoscula_object_size = 2.0; // the object\'s size in meters; inoscula_light_bridge.gd sets it\n' : ''}
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
${ir.glass ? godotGlass(ir, o) : ''}  ALBEDO = g_out_color;
${ir.alpha ? '  ALPHA = g_out_alpha;\n' : ''}${ir.cutout && !o.bakeUV ? '  ALPHA_SCISSOR_THRESHOLD = 0.5;\n' : ''}${ir.lit && !o.bakeUV ? `  ROUGHNESS = clamp(g_out_rough, 0.0, 1.0);
  METALLIC = clamp(g_out_metal, 0.0, 1.0);
  EMISSION = g_out_emit${ir.glass ? ' + g_behind * g_out_glass' : ''};
${ir.bump ? '  NORMAL = inoscula_bump(VERTEX, NORMAL, g_out_bump);\n' : ''}${ir.layers.coat ? '  CLEARCOAT = clamp(g_out_coat, 0.0, 1.0);\n  CLEARCOAT_ROUGHNESS = clamp(g_out_coat_rough, 0.0, 1.0);\n' : ''}${ir.layers.sheen ? '  RIM = clamp(g_out_sheen, 0.0, 1.0); // Godot has no sheen layer; rim lighting is its closest\n  RIM_TINT = 0.5;\n' : ''}${ir.layers.subsurface ? '  SSS_STRENGTH = clamp(g_out_sss, 0.0, 1.0);\n' : ''}` : ''}
}
`
}

// Glass: the screen behind the object, read a little to the side along the view space normal, once per color
// channel. Godot's screen texture has its origin top left, so the bend's y is flipped.
function godotGlass(ir: IR, o: GodotOpts) {
  const behind = o.bakeUV ? '  vec3 g_behind = vec3(0.0); // flattened for the bake: nothing behind\n' : `  vec3 g_vn = normalize((VIEW_MATRIX * vec4(normalize(g_vwnrm), 0.0)).xyz);
  vec2 g_bend = -g_vn.xy * vec2(1.0, -1.0) * (g_out_ior - 1.0) * 0.2;
  vec3 g_behind = vec3(texture(inoscula_screen, SCREEN_UV + g_bend * (1.0 - 0.5 * g_out_disp)).r,
    texture(inoscula_screen, SCREEN_UV + g_bend).g,
    texture(inoscula_screen, SCREEN_UV + g_bend * (1.0 + 0.5 * g_out_disp)).b);
`
  return ir.lit ? `${behind}  g_out_color *= 1.0 - g_out_glass;\n` : `${behind}  g_out_color = mix(g_out_color, g_behind, g_out_glass);\n`
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
  const w = ir.outline.width, c = ir.outline.color, b = ir.outline.breakup, of = ir.outline.offset, bo = ir.outline.boil
  const one = (a: any, name: string) => a.k === 'ref' ? `uniform float ${a.id} = ${num(ir.params.find((q) => 'p_' + q.id === a.id)!.default as number)};` : `const float ${name} = ${num(a.v as number)};`
  const bv = one(b, 'inoscula_ob'), ofv = one(of, 'inoscula_ooff'), bov = one(bo, 'inoscula_oboil')
  const W = w.k === 'ref' ? w.id : 'inoscula_ow', OF = of.k === 'ref' ? of.id : 'inoscula_ooff', BO = bo.k === 'ref' ? bo.id : 'inoscula_oboil'
  return `// ${ir.name}: outline pass. Set this as the Next Pass of the ${ir.name} material.
// inoscula-graph: ${JSON.stringify(ir.source)}
shader_type spatial;
render_mode unshaded, cull_front;

${val(w, 'float')}
${val(c, 'vec3')}
${bv}
${ofv}
${bov}
instance uniform float inoscula_object_size = 2.0; // the object's size in meters; inoscula_light_bridge.gd sets it
varying vec3 g_vobj;

vec3 inoscula_canon(vec3 p) { return vec3(p.x, -p.z, p.y); }
${noiseHelpers(LANG.godot)}
void vertex() {
  g_vobj = VERTEX;
  VERTEX += normalize(NORMAL) * (${W} + ${OF}) / max(length((MODEL_MATRIX * vec4(normalize(NORMAL), 0.0)).xyz), 1e-6);
}

void fragment() {
  // boil: the noise jumps to a new place this many times a second, so the line redraws like hand animation
  float g_seed = ${BO} > 0.0 ? floor(TIME * ${BO}) : 0.0;
  vec3 g_q = inoscula_canon(g_vobj) + fract(g_seed * vec3(0.1031, 0.1030, 0.0973)) * 37.0;
  float bk = ${b.k === 'ref' ? b.id : 'inoscula_ob'};
  if (bk > 0.0 && inoscula_noise(g_q, 30.0, 2.0, 0.5, 2.0) < bk) discard;
  float g_face = abs(dot(normalize(NORMAL), normalize(VIEW)));
  // offset: leave a gap between the surface and the line (measured as if the shape were round)
  if (${OF} > 0.0) {
    float g_r = inoscula_object_size * 0.5;
    float g_k = (g_r + ${OF}) / (g_r + ${OF} + ${W});
    if (g_face > sqrt(max(1.0 - g_k * g_k, 0.0))) discard;
  }
${ir.outline.rings ? `  // loose offset lines: thin rings across the halo, each wobbling on its own
  if (g_face > 0.55) discard;
  if (fract(g_face * ${ir.outline.rings}.0 * 1.6 + inoscula_noise(g_q, 3.0, 1.0, 0.5, 2.0) * 0.7) > 0.3) discard;
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
		# outline passes sit in next_pass and need the object's size too
		for i in range(mats.size()):
			var p = mats[i].next_pass
			while p != null:
				mats.append(p)
				p = p.next_pass
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
