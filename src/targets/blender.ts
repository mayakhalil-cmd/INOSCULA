// Blender target: a Python script that builds the shader as real, native nodes (Eevee and Cycles), inside a node
// group whose inputs are the parameters. No code nodes and no baking: Eevee has no code node, so every step is
// expanded into Blender's own Math, Vector Math, Mix, Map Range, Color Ramp and Noise Texture nodes.
import type { Arg, IR, Step } from '../spec.ts'
import { rampStops } from '../spec.ts'

const py = (s: string) => JSON.stringify(s)
const pyNum = (x: number) => (Number.isFinite(x) ? String(x) : '0.0')

interface Ctx { lines: string[]; n: number; depth: Map<string, number>; sock: Map<string, string> }

// The outline from the classic hand-built setup: a Solidify modifier with flipped normals that uses a second
// material, which is see-through where it faces the camera. Width and colour follow the group's parameters.
function blenderOutline(ir: IR, label: (a: Arg) => string | null): string {
  const o = ir.outline!
  const wl = label(o.width), cl = label(o.color), bl = label(o.breakup)
  const bvv = o.breakup.k === 'lit' ? pyNum(o.breakup.v as number) : '0.0'
  const wv = o.width.k === 'lit' ? pyNum(o.width.v as number) : '0.02'
  const cv = o.color.k === 'lit' ? `(${(o.color.v as number[]).map(pyNum).join(', ')}, 1.0)` : '(0.02, 0.02, 0.03, 1.0)'
  return `# ---- outline: Solidify (flipped normals) with its own material on every object that uses this one
om = bpy.data.materials.get(MAT + " Outline") or bpy.data.materials.new(MAT + " Outline")
om.use_backface_culling = True
ont = om.node_tree
ont.nodes.clear()
o_geo = ont.nodes.new("ShaderNodeNewGeometry")
o_em = ont.nodes.new("ShaderNodeEmission")
o_em.inputs["Color"].default_value = ${cv}
o_tr = ont.nodes.new("ShaderNodeBsdfTransparent")
o_mx = ont.nodes.new("ShaderNodeMixShader")
# a broken, hand-inked line: noise on the object's own coordinates eats into it (the same noise as every tool)
o_tc = ont.nodes.new("ShaderNodeTexCoord")
o_nz = ont.nodes.new("ShaderNodeTexNoise")
o_nz.noise_dimensions = "3D"
if hasattr(o_nz, "noise_type"):
    o_nz.noise_type = "FBM"
if hasattr(o_nz, "normalize"):
    o_nz.normalize = True
for k, val in (("Scale", 30.0), ("Detail", 2.0), ("Roughness", 0.5), ("Lacunarity", 2.0), ("Distortion", 0.0)):
    S(o_nz.inputs, k).default_value = val
ont.links.new(o_tc.outputs["Object"], S(o_nz.inputs, "Vector"))
o_bk = ont.nodes.new("ShaderNodeValue")
o_bk.label = "Outline Breakup"
o_bk.outputs[0].default_value = ${bvv}
o_lt = ont.nodes.new("ShaderNodeMath")
o_lt.operation = "LESS_THAN"
ont.links.new(S(o_nz.outputs, "Fac"), o_lt.inputs[0])
ont.links.new(o_bk.outputs[0], o_lt.inputs[1])
o_hide = ont.nodes.new("ShaderNodeMath")
o_hide.operation = "MAXIMUM"
ont.links.new(o_geo.outputs["Backfacing"], o_hide.inputs[0])
ont.links.new(o_lt.outputs[0], o_hide.inputs[1])
# only the camera sees the shell: shadows, bounces and reflections pass straight through it
o_lp = ont.nodes.new("ShaderNodeLightPath")
o_cam = ont.nodes.new("ShaderNodeMath")
o_cam.operation = "SUBTRACT"
o_cam.inputs[0].default_value = 1.0
ont.links.new(o_lp.outputs["Is Camera Ray"], o_cam.inputs[1])
o_hide2 = ont.nodes.new("ShaderNodeMath")
o_hide2.operation = "MAXIMUM"
ont.links.new(o_hide.outputs[0], o_hide2.inputs[0])
ont.links.new(o_cam.outputs[0], o_hide2.inputs[1])
${o.rings ? `# loose offset lines: thin rings across the halo, each wobbling on its own
o_dot = ont.nodes.new("ShaderNodeVectorMath")
o_dot.operation = "DOT_PRODUCT"
ont.links.new(o_geo.outputs["Normal"], o_dot.inputs[0])
ont.links.new(o_geo.outputs["Incoming"], o_dot.inputs[1])
o_abs = ont.nodes.new("ShaderNodeMath")
o_abs.operation = "ABSOLUTE"
ont.links.new(S(o_dot.outputs, "Value"), o_abs.inputs[0])
o_rm = ont.nodes.new("ShaderNodeMath")
o_rm.operation = "MULTIPLY"
o_rm.inputs[1].default_value = ${o.rings * 1.6}
ont.links.new(o_abs.outputs[0], o_rm.inputs[0])
o_rn = ont.nodes.new("ShaderNodeTexNoise")
o_rn.noise_dimensions = "3D"
if hasattr(o_rn, "noise_type"):
    o_rn.noise_type = "FBM"
if hasattr(o_rn, "normalize"):
    o_rn.normalize = True
for k, val in (("Scale", 3.0), ("Detail", 1.0), ("Roughness", 0.5), ("Lacunarity", 2.0), ("Distortion", 0.0)):
    S(o_rn.inputs, k).default_value = val
ont.links.new(o_tc.outputs["Object"], S(o_rn.inputs, "Vector"))
o_rw = ont.nodes.new("ShaderNodeMath")
o_rw.operation = "MULTIPLY_ADD"
ont.links.new(S(o_rn.outputs, "Fac"), o_rw.inputs[0])
o_rw.inputs[1].default_value = 0.7
ont.links.new(o_rm.outputs[0], o_rw.inputs[2])
o_fr = ont.nodes.new("ShaderNodeMath")
o_fr.operation = "FRACT"
ont.links.new(o_rw.outputs[0], o_fr.inputs[0])
o_rg = ont.nodes.new("ShaderNodeMath")
o_rg.operation = "GREATER_THAN"
o_rg.inputs[1].default_value = 0.3
ont.links.new(o_fr.outputs[0], o_rg.inputs[0])
o_hide3 = ont.nodes.new("ShaderNodeMath")
o_hide3.operation = "MAXIMUM"
ont.links.new(o_hide2.outputs[0], o_hide3.inputs[0])
ont.links.new(o_rg.outputs[0], o_hide3.inputs[1])
ont.links.new(o_hide3.outputs[0], o_mx.inputs[0])
` : 'ont.links.new(o_hide2.outputs[0], o_mx.inputs[0])\n'}for prop, val in (("use_transparent_shadow", True), ("shadow_method", "NONE")):
    try:
        setattr(om, prop, val)
    except Exception:
        pass
${bl ? `d = o_bk.outputs[0].driver_add("default_value").driver
d.type = "AVERAGE"
v = d.variables.new()
v.type = "SINGLE_PROP"
v.targets[0].id_type = "MATERIAL"
v.targets[0].id = m
v.targets[0].data_path = 'node_tree.nodes["%s"].inputs["%s"].default_value' % (gn.name, ${py(bl)})
` : ''}
ont.links.new(o_em.outputs[0], o_mx.inputs[1])
ont.links.new(o_tr.outputs[0], o_mx.inputs[2])
o_out = ont.nodes.new("ShaderNodeOutputMaterial")
ont.links.new(o_mx.outputs[0], o_out.inputs["Surface"])
${cl ? `for i in range(3):
    d = o_em.inputs["Color"].driver_add("default_value", i).driver
    d.type = "AVERAGE"
    v = d.variables.new()
    v.type = "SINGLE_PROP"
    v.targets[0].id_type = "MATERIAL"
    v.targets[0].id = m
    v.targets[0].data_path = 'node_tree.nodes["%s"].inputs["%s"].default_value[%d]' % (gn.name, ${py(cl)}, i)
` : ''}
targets = [ob for ob in bpy.data.objects if ob.type == "MESH" and any(s.material == m for s in ob.material_slots)]
targets += [ob for ob in bpy.context.selected_objects if ob.type == "MESH" and ob not in targets]
for ob in targets:
    if m.name not in [s.material.name for s in ob.material_slots if s.material]:
        ob.data.materials.append(m)
    if om.name not in [s.material.name for s in ob.material_slots if s.material]:
        ob.data.materials.append(om)
    mod = ob.modifiers.get("Inoscula Outline") or ob.modifiers.new("Inoscula Outline", "SOLIDIFY")
    mod.use_flip_normals = True
    mod.use_rim = False
    mod.offset = 1.0
    mod.thickness = ${wv}
    mod.material_offset = [s.material.name if s.material else "" for s in ob.material_slots].index(om.name)
${wl ? `    d = mod.driver_add("thickness").driver
    d.type = "AVERAGE"
    v = d.variables.new()
    v.type = "SINGLE_PROP"
    v.targets[0].id_type = "MATERIAL"
    v.targets[0].id = m
    v.targets[0].data_path = 'node_tree.nodes["%s"].inputs["%s"].default_value' % (gn.name, ${py(wl)})
    # a width of 0 turns the outline off, rather than leaving a shell on the surface
    for prop in ("show_render", "show_viewport"):
        d = mod.driver_add(prop).driver
        d.type = "SCRIPTED"
        d.expression = "w > 0.0001"
        v = d.variables.new()
        v.name = "w"
        v.type = "SINGLE_PROP"
        v.targets[0].id_type = "MATERIAL"
        v.targets[0].id = m
        v.targets[0].data_path = 'node_tree.nodes["%s"].inputs["%s"].default_value' % (gn.name, ${py(wl)})
` : `    mod.show_render = mod.show_viewport = ${wv} > 0.0001
`}
`
}

export function toBlender(ir: IR): string {
  const c: Ctx = { lines: [], n: 0, depth: new Map(), sock: new Map() }
  const L = (s: string) => c.lines.push(s)
  const groupName = 'Inoscula ' + ir.name

  // ---- sources
  const need = (op: string) => ir.uses.has(op)
  const srcSock: Record<string, string> = {}
  if (need('uv') || need('object_pos') || need('object_normal')) {
    L(`tc = node("ShaderNodeTexCoord", -400, 300)`)
    srcSock.uv = 'tc.outputs["UV"]'; srcSock.object_pos = 'tc.outputs["Object"]'; srcSock.object_normal = 'tc.outputs["Normal"]'
  }
  if (need('world_pos') || need('normal') || need('view_dir')) {
    L(`geo = node("ShaderNodeNewGeometry", -400, 0)`)
    srcSock.world_pos = 'geo.outputs["Position"]'; srcSock.normal = 'geo.outputs["Normal"]'; srcSock.view_dir = 'geo.outputs["Incoming"]'
  }
  if (need('time')) {
    L(`tm = node("ShaderNodeValue", -400, -300)`)
    L(`tm.label = "Time (seconds)"`)
    L(`drive_time(tm.outputs[0])`)
    srcSock.time = 'tm.outputs[0]'
  }
  if (need('curvature') || need('occlusion')) {
    // shape data lives in the mesh's colour attribute (red curvature, green occlusion)
    L(`shape = node("ShaderNodeVertexColor", -400, -450)`)
    L(`shape.label = "Shape data (curvature, occlusion)"`)
    L(`shape_xyz = node("ShaderNodeSeparateXYZ", -200, -450)`)
    L(`link(shape.outputs["Color"], shape_xyz.inputs[0])`)
    // blue near 0.5 marks Inoscula shape data; without it (black here) read flat (0.5) and open (1.0)
    L(`shape_d = node("ShaderNodeMath", -50, -520); shape_d.operation = "SUBTRACT"; link(shape_xyz.outputs[2], shape_d.inputs[0]); shape_d.inputs[1].default_value = 0.5`)
    L(`shape_a = node("ShaderNodeMath", 100, -520); shape_a.operation = "ABSOLUTE"; link(shape_d.outputs[0], shape_a.inputs[0])`)
    L(`shape_has = node("ShaderNodeMath", 250, -520); shape_has.operation = "LESS_THAN"; link(shape_a.outputs[0], shape_has.inputs[0]); shape_has.inputs[1].default_value = 0.3`)
    L(`shape_c = node("ShaderNodeMix", 400, -420); shape_c.data_type = "FLOAT"; shape_c.clamp_factor = True; link(shape_has.outputs[0], S(shape_c.inputs, "Factor_Float")); S(shape_c.inputs, "A_Float").default_value = 0.5; link(shape_xyz.outputs[0], S(shape_c.inputs, "B_Float"))`)
    L(`shape_o = node("ShaderNodeMix", 400, -580); shape_o.data_type = "FLOAT"; shape_o.clamp_factor = True; link(shape_has.outputs[0], S(shape_o.inputs, "Factor_Float")); S(shape_o.inputs, "A_Float").default_value = 1.0; link(shape_xyz.outputs[1], S(shape_o.inputs, "B_Float"))`)
    L(`shape_c.label = "Inoscula Curvature"; shape_o.label = "Inoscula Occlusion"`) // labels let blender_to_inoscula.py read them back
    srcSock.curvature = 'S(shape_c.outputs, "Result_Float")'; srcSock.occlusion = 'S(shape_o.outputs, "Result_Float")'
  }
  if (need('object_size')) {
    // the object's size, from its property inoscula_object_size (this script sets it); 2.0 where it is missing
    L(`osz_a = node("ShaderNodeAttribute", -400, -700); osz_a.attribute_type = "OBJECT"; osz_a.attribute_name = "inoscula_object_size"`)
    L(`osz_h = node("ShaderNodeMath", -200, -700); osz_h.operation = "GREATER_THAN"; link(osz_a.outputs["Fac"], osz_h.inputs[0]); osz_h.inputs[1].default_value = 0.0001`)
    L(`osz = node("ShaderNodeMix", 0, -700); osz.data_type = "FLOAT"; osz.clamp_factor = True; link(osz_h.outputs[0], S(osz.inputs, "Factor_Float")); S(osz.inputs, "A_Float").default_value = 2.0; link(osz_a.outputs["Fac"], S(osz.inputs, "B_Float"))`)
    L(`osz.label = "Inoscula Object Size"`)
    srcSock.object_size = 'S(osz.outputs, "Result_Float")'
  }
  if (need('light_dir')) srcSock.light_dir = 'gin("Light Direction")'
  if (need('light_color')) srcSock.light_color = 'gin("Light Color")'

  // a wire as either a linked socket or a value to type into the input
  const arg = (a: Arg): { link?: string; val?: string } => {
    if (a.k === 'lit') return { val: typeof a.v === 'number' ? (a.type === 'vec3' ? `(${pyNum(a.v)}, ${pyNum(a.v)}, ${pyNum(a.v)})` : pyNum(a.v)) : `(${a.v.map(pyNum).join(', ')})` }
    const s = c.sock.get(a.id)
    if (!s) throw new Error('internal: unknown ' + a.id)
    return { link: s }
  }
  const depthOf = (s: Step) => 1 + Math.max(0, ...s.args.map((a) => (a.k === 'ref' ? c.depth.get(a.id.replace(/_(x|y|z|color|position)$/, '')) ?? 0 : 0)))
  const feed = (target: string, a: Arg) => {
    const r = arg(a)
    if (r.link) L(`link(${r.link}, ${target})`)
    else L(`setv(${target}, ${r.val})`)
  }

  for (const p of ir.params) c.sock.set('p_' + p.id, `gin(${py(p.label ?? p.id)})`)

  let row = 0
  for (const s of ir.steps) {
    const d = depthOf(s)
    c.depth.set(s.id, d)
    const x = d * 220, y = -(row++ % 8) * 170 + 600
    const v = s.type === 'vec3'
    const id = s.id
    const math = (op: string, ins: number[], out = 0) => {
      L(`${id} = node(${py(v ? 'ShaderNodeVectorMath' : 'ShaderNodeMath')}, ${x}, ${y})`)
      L(`${id}.operation = ${py(op)}`)
      ins.forEach((ai, k) => feed(`${id}.inputs[${k}]`, s.args[ai]))
      c.sock.set(id, `${id}.outputs[${out}]`)
    }
    const mathV = (op: string, ins: number[], out: number) => { // vector maths with a float result (dot, length)
      L(`${id} = node("ShaderNodeVectorMath", ${x}, ${y})`)
      L(`${id}.operation = ${py(op)}`)
      ins.forEach((ai, k) => feed(`${id}.inputs[${k}]`, s.args[ai]))
      c.sock.set(id, `${id}.outputs[${out}]`)
    }
    // Vector Math has no Power, Exponent or Square Root, so do those per component with plain Math nodes,
    // which is exactly what the float version does.
    const perComp = (op: string, n: number) => {
      for (let a = 0; a < n; a++) { L(`${id}_${'ab'[a]} = node("ShaderNodeSeparateXYZ", ${x - 60}, ${y - 60 * a})`); feed(`${id}_${'ab'[a]}.inputs[0]`, s.args[a]) }
      L(`${id} = node("ShaderNodeCombineXYZ", ${x + 120}, ${y})`)
      for (let k = 0; k < 3; k++) {
        L(`${id}_${k} = node("ShaderNodeMath", ${x + 30}, ${y - 40 * k})`); L(`${id}_${k}.operation = ${py(op)}`)
        for (let a = 0; a < n; a++) L(`link(${id}_${'ab'[a]}.outputs[${k}], ${id}_${k}.inputs[${a}])`)
        L(`link(${id}_${k}.outputs[0], ${id}.inputs[${k}])`)
      }
      c.sock.set(id, `${id}.outputs[0]`)
    }
    switch (s.op) {
      case 'uv': case 'object_pos': case 'object_normal': case 'world_pos': case 'normal': case 'view_dir': case 'time': case 'light_dir': case 'light_color': case 'curvature': case 'occlusion': case 'object_size':
        c.sock.set(id, srcSock[s.op]); c.depth.set(id, 0); row--; break
      case 'value':
        if (v) { L(`${id} = node("ShaderNodeCombineXYZ", ${x}, ${y})`); (s.set.v as number[]).forEach((n, k) => L(`setv(${id}.inputs[${k}], ${pyNum(n)})`)) }
        else { L(`${id} = node("ShaderNodeValue", ${x}, ${y})`); L(`${id}.outputs[0].default_value = ${pyNum(s.set.v as number)}`) }
        c.sock.set(id, `${id}.outputs[0]`); break
      case 'add': math('ADD', [0, 1]); break
      case 'sub': math('SUBTRACT', [0, 1]); break
      case 'mul': math('MULTIPLY', [0, 1]); break
      case 'div': math('DIVIDE', [0, 1]); break
      case 'min': math('MINIMUM', [0, 1]); break
      case 'max': math('MAXIMUM', [0, 1]); break
      case 'abs': math('ABSOLUTE', [0]); break
      case 'floor': math('FLOOR', [0]); break
      case 'fract': math(v ? 'FRACTION' : 'FRACT', [0]); break
      case 'sin': math('SINE', [0]); break
      case 'cos': math('COSINE', [0]); break
      case 'pow': if (!v) math('POWER', [0, 1]); else perComp('POWER', 2); break
      case 'exp': if (!v) math('EXPONENT', [0]); else perComp('EXPONENT', 1); break
      case 'sqrt': if (!v) math('SQRT', [0]); else perComp('SQRT', 1); break
      case 'atan2': math('ARCTAN2', [0, 1]); break
      case 'white_noise':
        L(`${id} = node("ShaderNodeTexWhiteNoise", ${x}, ${y})`); L(`${id}.noise_dimensions = "3D"`)
        feed(`S(${id}.inputs, "Vector")`, s.args[0])
        c.sock.set(id, `S(${id}.outputs, "Value")`); break
      case 'one_minus':
        L(`${id} = node(${py(v ? 'ShaderNodeVectorMath' : 'ShaderNodeMath')}, ${x}, ${y})`); L(`${id}.operation = "SUBTRACT"`)
        L(`setv(${id}.inputs[0], ${v ? '(1.0, 1.0, 1.0)' : '1.0'})`); feed(`${id}.inputs[1]`, s.args[0])
        c.sock.set(id, `${id}.outputs[0]`); break
      case 'clamp':
        if (!v) {
          L(`${id} = node("ShaderNodeClamp", ${x}, ${y})`); L(`${id}.clamp_type = "MINMAX"`)
          feed(`${id}.inputs[0]`, s.args[0]); feed(`${id}.inputs[1]`, s.args[1]); feed(`${id}.inputs[2]`, s.args[2])
          c.sock.set(id, `${id}.outputs[0]`)
        } else {
          L(`${id}_lo = node("ShaderNodeVectorMath", ${x - 40}, ${y})`); L(`${id}_lo.operation = "MAXIMUM"`)
          feed(`${id}_lo.inputs[0]`, s.args[0]); feed(`${id}_lo.inputs[1]`, s.args[1])
          L(`${id} = node("ShaderNodeVectorMath", ${x + 40}, ${y})`); L(`${id}.operation = "MINIMUM"`)
          L(`link(${id}_lo.outputs[0], ${id}.inputs[0])`); feed(`${id}.inputs[1]`, s.args[2])
          c.sock.set(id, `${id}.outputs[0]`)
        }
        break
      case 'mix': {
        const k = v ? 'Vector' : 'Float'
        L(`${id} = node("ShaderNodeMix", ${x}, ${y})`); L(`${id}.data_type = ${py(v ? 'VECTOR' : 'FLOAT')}`)
        if (v) L(`${id}.factor_mode = "UNIFORM"`)
        L(`${id}.clamp_factor = True`)
        feed(`S(${id}.inputs, "Factor_Float")`, s.args[2])
        feed(`S(${id}.inputs, "A_${k}")`, s.args[0]); feed(`S(${id}.inputs, "B_${k}")`, s.args[1])
        c.sock.set(id, `S(${id}.outputs, "Result_${k}")`); break
      }
      case 'smoothstep':
        L(`${id} = node("ShaderNodeMapRange", ${x}, ${y})`); L(`${id}.interpolation_type = "SMOOTHSTEP"`); L(`${id}.clamp = True`)
        feed(`S(${id}.inputs, "Value")`, s.args[2]); feed(`S(${id}.inputs, "From Min")`, s.args[0]); feed(`S(${id}.inputs, "From Max")`, s.args[1])
        L(`setv(S(${id}.inputs, "To Min"), 0.0)`); L(`setv(S(${id}.inputs, "To Max"), 1.0)`)
        c.sock.set(id, `S(${id}.outputs, "Result")`); break
      case 'greater': math('GREATER_THAN', [0, 1]); break
      case 'dot': mathV('DOT_PRODUCT', [0, 1], 1); break
      case 'length': mathV('LENGTH', [0], 1); break
      case 'normalize': math('NORMALIZE', [0]); break
      case 'combine':
        L(`${id} = node("ShaderNodeCombineXYZ", ${x}, ${y})`); [0, 1, 2].forEach((k) => feed(`${id}.inputs[${k}]`, s.args[k]))
        c.sock.set(id, `${id}.outputs[0]`); break
      case 'separate':
        L(`${id} = node("ShaderNodeSeparateXYZ", ${x}, ${y})`); feed(`${id}.inputs[0]`, s.args[0])
        ;['x', 'y', 'z'].forEach((k, i) => c.sock.set(`${id}_${k}`, `${id}.outputs[${i}]`))
        break
      case 'noise':
        L(`${id} = node("ShaderNodeTexNoise", ${x}, ${y})`); L(`noise_setup(${id})`)
        feed(`S(${id}.inputs, "Vector")`, s.args[0]); feed(`S(${id}.inputs, "Scale")`, s.args[1]); feed(`S(${id}.inputs, "Detail")`, s.args[2])
        feed(`S(${id}.inputs, "Roughness")`, s.args[3]); feed(`S(${id}.inputs, "Lacunarity")`, s.args[4])
        c.sock.set(id, `S(${id}.outputs, "Fac")`); break
      case 'voronoi':
        L(`${id} = node("ShaderNodeTexVoronoi", ${x}, ${y})`); L(`voronoi_setup(${id})`)
        feed(`S(${id}.inputs, "Vector")`, s.args[0]); feed(`S(${id}.inputs, "Scale")`, s.args[1]); feed(`S(${id}.inputs, "Randomness")`, s.args[2])
        c.sock.set(id, `S(${id}.outputs, "Distance")`); c.sock.set(`${id}_color`, `S(${id}.outputs, "Color")`); c.sock.set(`${id}_position`, `S(${id}.outputs, "Position")`)
        break
      case 'ramp': {
        L(`${id} = node("ShaderNodeValToRGB", ${x}, ${y})`)
        const stops = rampStops(s.set)
        L(`ramp_setup(${id}, ${py(s.set.mode === 'constant' ? 'CONSTANT' : 'LINEAR')}, [${stops.map(([p, col]) => `(${pyNum(p)}, (${col.map(pyNum).join(', ')}))`).join(', ')}])`)
        feed(`${id}.inputs[0]`, s.args[0])
        c.sock.set(id, `${id}.outputs["Color"]`); break
      }
      default: throw new Error(`Blender target has no ${s.op} yet`)
    }
  }

  const maxD = Math.max(1, ...c.depth.values())
  const outX = (maxD + 1) * 220
  const color = arg(ir.color), alpha = ir.alpha ? arg(ir.alpha) : null
  // lit outputs go out of the group as extra sockets
  const litOuts: [string, string, Arg | null, string][] = ir.lit ? [
    ['Roughness', 'NodeSocketFloat', ir.roughness, '0.5'],
    ['Metallic', 'NodeSocketFloat', ir.metallic, '0.0'],
    ['Height', 'NodeSocketFloat', ir.bump, '0.0'],
    ['Emission', 'NodeSocketColor', ir.emission, '(0.0, 0.0, 0.0, 1.0)'],
    ...(ir.layers.coat ? [['Coat', 'NodeSocketFloat', ir.layers.coat, '0.0'], ['Coat Roughness', 'NodeSocketFloat', ir.layers.coat_roughness, '0.03']] as [string, string, Arg | null, string][] : []),
    ...(ir.layers.sheen ? [['Sheen', 'NodeSocketFloat', ir.layers.sheen, '0.0'], ['Sheen Tint', 'NodeSocketColor', ir.layers.sheen_color, '(1.0, 1.0, 1.0, 1.0)'], ['Sheen Roughness', 'NodeSocketFloat', ir.layers.sheen_roughness, '0.5']] as [string, string, Arg | null, string][] : []),
    ...(ir.layers.subsurface ? [['Subsurface', 'NodeSocketFloat', ir.layers.subsurface, '0.0']] as [string, string, Arg | null, string][] : []),
  ] : []
  // the group input label behind a parameter wire (for drivers), or null for a fixed value
  const outLabel = (a: Arg) => { if (a.k !== 'ref' || !a.id.startsWith('p_')) return null; const p = ir.params.find((q) => 'p_' + q.id === a.id); return p ? (p.label ?? p.id) : null }
  const outLine = (nm: string, a: Arg | null, fallback: string, isColor: boolean) => {
    if (!a) return `go.inputs[${py(nm)}].default_value = ${fallback}`
    const r = arg(a)
    if (r.link) return `link(${r.link}, go.inputs[${py(nm)}])`
    return isColor ? `go.inputs[${py(nm)}].default_value = (*${r.val}, 1.0)` : `go.inputs[${py(nm)}].default_value = ${r.val}`
  }

  const params = ir.params.map((p) => {
    const nm = py(p.label ?? p.id)
    if (p.t === 'float') return `sock_in(${nm}, "NodeSocketFloat", ${pyNum(p.default as number)}, ${p.min ?? 'None'}, ${p.max ?? 'None'})`
    const v = p.default as number[]
    return p.type === 'color'
      ? `sock_in(${nm}, "NodeSocketColor", (${v.map(pyNum).join(', ')}, 1.0))`
      : `sock_in(${nm}, "NodeSocketVector", (${v.map(pyNum).join(', ')}))`
  })
  if (need('light_dir')) params.push('sock_in("Light Direction", "NodeSocketVector", (0.4, -0.45, 0.8))')
  if (need('light_color')) params.push('sock_in("Light Color", "NodeSocketColor", (1.0, 1.0, 1.0, 1.0))')

  return `# ${ir.name}, made with Inoscula. Builds native Blender shader nodes (Eevee and Cycles), fully editable.
# Run it in Blender's Text Editor (Run Script) or: blender --python this_file.py
# Makes the node group ${py(groupName)} and the material ${py(ir.name)} that uses it. If an object called
# "RICO Sun" (any Sun light) exists, the material's Light Direction and Light Color follow it through drivers.
import bpy

GROUP = ${py(groupName)}
MAT = ${py(ir.name)}

def S(socks, key):
    for s in socks:
        if s.identifier == key:
            return s
    for s in socks:
        if s.name == key and s.enabled:
            return s
    raise KeyError(key)

g = bpy.data.node_groups.get(GROUP) or bpy.data.node_groups.new(GROUP, "ShaderNodeTree")
g.nodes.clear()
for item in list(g.interface.items_tree):
    g.interface.remove(item)

def sock_in(name, kind, default, lo=None, hi=None):
    s = g.interface.new_socket(name, in_out="INPUT", socket_type=kind)
    s.default_value = default
    if lo is not None:
        s.min_value = lo
    if hi is not None:
        s.max_value = hi
    return s

${params.join('\n') || '# no parameters'}
g.interface.new_socket("Color", in_out="OUTPUT", socket_type="NodeSocketColor")
g.interface.new_socket("Alpha", in_out="OUTPUT", socket_type="NodeSocketFloat")
${litOuts.map(([nm, kind]) => `g.interface.new_socket(${py(nm)}, in_out="OUTPUT", socket_type=${py(kind)})`).join('\n')}

g["inoscula_graph"] = ${py(JSON.stringify(ir.source))}  # the Inoscula graph, so it can be read back

gi = g.nodes.new("NodeGroupInput")
gi.location = (-700, 0)
go = g.nodes.new("NodeGroupOutput")
go.location = (${outX}, 0)

def gin(name):
    return gi.outputs[name]

def node(kind, x, y):
    n = g.nodes.new(kind)
    n.location = (x, y)
    return n

def link(a, b):
    g.links.new(a, b)

def setv(sock, v):
    sock.default_value = v

def drive_time(sock):
    d = sock.driver_add("default_value").driver
    d.type = "SCRIPTED"
    v = d.variables.new()
    v.name = "fps"
    v.type = "SINGLE_PROP"
    v.targets[0].id_type = "SCENE"
    v.targets[0].id = bpy.context.scene
    v.targets[0].data_path = "render.fps"
    d.expression = "frame / fps"

def noise_setup(n):
    n.noise_dimensions = "3D"
    if hasattr(n, "noise_type"):
        n.noise_type = "FBM"
    if hasattr(n, "normalize"):
        n.normalize = True
    else:
        S(n.inputs, "Normalize").default_value = True
    S(n.inputs, "Distortion").default_value = 0.0

def voronoi_setup(n):
    n.voronoi_dimensions = "3D"
    n.feature = "F1"
    n.distance = "EUCLIDEAN"
    if hasattr(n, "normalize"):
        n.normalize = False
    for key, v in (("Detail", 0.0), ("Roughness", 0.5), ("Lacunarity", 2.0)):
        try:
            S(n.inputs, key).default_value = v
        except KeyError:
            pass

def ramp_setup(n, mode, stops):
    r = n.color_ramp
    r.interpolation = mode
    while len(r.elements) > 1:
        r.elements.remove(r.elements[-1])
    r.elements[0].position = stops[0][0]
    r.elements[0].color = (*stops[0][1], 1.0)
    for p, c in stops[1:]:
        e = r.elements.new(p)
        e.color = (*c, 1.0)

${c.lines.join('\n')}

${color.link ? `link(${color.link}, go.inputs["Color"])` : `go.inputs["Color"].default_value = (*${color.val}, 1.0)`}
${alpha ? (alpha.link ? `link(${alpha.link}, go.inputs["Alpha"])` : `go.inputs["Alpha"].default_value = ${alpha.val}`) : 'go.inputs["Alpha"].default_value = 1.0'}
${litOuts.map(([nm, kind, a, fb]) => outLine(nm, a, fb, kind === 'NodeSocketColor')).join('\n')}

# ---- the material${ir.lit ? ': group -> Principled BSDF, lit by Blender (Eevee or Cycles)' : ': group -> Emission (unlit, so it looks the same as in every other engine)'}
m = bpy.data.materials.get(MAT) or bpy.data.materials.new(MAT)
if hasattr(m, "use_nodes"):
    try:
        m.use_nodes = True
    except Exception:
        pass
${ir.source.shells ? `m["inoscula_shells"] = "${JSON.stringify([ir.source.shells.rim, ir.source.shells.outline, ir.source.shells.offset])}"  # rim and offset outlines: run importers/inoscula_shells_blender.py with the model selected\n` : ''}${ir.source.cards ? `m["inoscula_cards"] = "${JSON.stringify([ir.source.cards.count, ir.source.cards.length, ir.source.cards.width, ir.source.cards.lift ?? 0.12])}"  # brush cards for this look: run importers/inoscula_cards_blender.py with the model selected\n` : ''}nt = m.node_tree
nt.nodes.clear()
gn = nt.nodes.new("ShaderNodeGroup")
gn.node_tree = g
gn.location = (0, 0)
out = nt.nodes.new("ShaderNodeOutputMaterial")
out.location = (650, 0)
${ir.lit ? `bs = nt.nodes.new("ShaderNodeBsdfPrincipled")
bs.location = (300, 0)
nt.links.new(gn.outputs["Color"], S(bs.inputs, "Base Color"))
nt.links.new(gn.outputs["Roughness"], S(bs.inputs, "Roughness"))
nt.links.new(gn.outputs["Metallic"], S(bs.inputs, "Metallic"))
nt.links.new(gn.outputs["Emission"], S(bs.inputs, "Emission Color"))
S(bs.inputs, "Emission Strength").default_value = 1.0
${ir.layers.coat ? 'nt.links.new(gn.outputs["Coat"], S(bs.inputs, "Coat Weight"))\nnt.links.new(gn.outputs["Coat Roughness"], S(bs.inputs, "Coat Roughness"))\n' : ''}${ir.layers.sheen ? 'nt.links.new(gn.outputs["Sheen"], S(bs.inputs, "Sheen Weight"))\nnt.links.new(gn.outputs["Sheen Tint"], S(bs.inputs, "Sheen Tint"))\nnt.links.new(gn.outputs["Sheen Roughness"], S(bs.inputs, "Sheen Roughness"))\n' : ''}${ir.layers.subsurface ? 'nt.links.new(gn.outputs["Subsurface"], S(bs.inputs, "Subsurface Weight"))\nS(bs.inputs, "Subsurface Radius").default_value = (1.0, 0.35, 0.2)\n' : ''}${alpha ? 'nt.links.new(gn.outputs["Alpha"], S(bs.inputs, "Alpha"))\n' : ''}${ir.bump ? `bp = nt.nodes.new("ShaderNodeBump")
bp.location = (150, -250)
S(bp.inputs, "Strength").default_value = 1.0
S(bp.inputs, "Distance").default_value = 1.0
nt.links.new(gn.outputs["Height"], S(bp.inputs, "Height"))
nt.links.new(bp.outputs["Normal"], S(bs.inputs, "Normal"))
` : ''}nt.links.new(bs.outputs[0], out.inputs["Surface"])` : `em = nt.nodes.new("ShaderNodeEmission")
em.location = (250, 0)
nt.links.new(gn.outputs["Color"], em.inputs["Color"])
em.inputs["Strength"].default_value = 1.0
${alpha ? `tr = nt.nodes.new("ShaderNodeBsdfTransparent")
tr.location = (250, 150)
mx = nt.nodes.new("ShaderNodeMixShader")
mx.location = (450, 0)
nt.links.new(gn.outputs["Alpha"], mx.inputs[0])
nt.links.new(tr.outputs[0], mx.inputs[1])
nt.links.new(em.outputs[0], mx.inputs[2])
nt.links.new(mx.outputs[0], out.inputs["Surface"])` : 'nt.links.new(em.outputs[0], out.inputs["Surface"])'}`}

${ir.cutout && alpha ? `# ---- cutout: alpha is cut at 0.5 and both sides show (brush cards)
cut = nt.nodes.new("ShaderNodeMath")
cut.operation = "GREATER_THAN"
cut.inputs[1].default_value = 0.5
cut.location = (150, 300)
nt.links.new(gn.outputs["Alpha"], cut.inputs[0])
for ln in list(nt.links):
    if ln.from_node == gn and ln.from_socket.name == "Alpha" and ln.to_node != cut:
        to = ln.to_socket
        nt.links.remove(ln)
        nt.links.new(cut.outputs[0], to)
m.use_backface_culling = False
for attr, val in (("blend_method", "CLIP"), ("surface_render_method", "DITHERED")):
    try:
        setattr(m, attr, val)
    except Exception:
        pass
` : ''}${ir.outline ? blenderOutline(ir, outLabel) : ''}
# ---- light bridge: follow a sun called "RICO Sun", or the first sun in the file
sun = bpy.data.objects.get("RICO Sun") or next((o for o in bpy.data.objects if o.type == "LIGHT" and o.data.type == "SUN"), None)
if sun is not None:
    if "Light Direction" in gn.inputs:
        q = (("w", "ROT_W"), ("x", "ROT_X"), ("y", "ROT_Y"), ("z", "ROT_Z"))
        for i, expr in enumerate(("2*(x*z+w*y)", "2*(y*z-w*x)", "1-2*(x*x+y*y)")):
            d = gn.inputs["Light Direction"].driver_add("default_value", i).driver
            d.type = "SCRIPTED"
            for name, ch in q:
                v = d.variables.new()
                v.name = name
                v.type = "TRANSFORMS"
                t = v.targets[0]
                t.id = sun
                t.transform_type = ch
                t.rotation_mode = "QUATERNION"
                t.transform_space = "WORLD_SPACE"
            d.expression = expr
    if "Light Color" in gn.inputs:
        for i in range(3):
            d = gn.inputs["Light Color"].driver_add("default_value", i).driver
            d.type = "AVERAGE"
            v = d.variables.new()
            v.type = "SINGLE_PROP"
            v.targets[0].id_type = "LIGHT"
            v.targets[0].id = sun.data
            v.targets[0].data_path = "color[%d]" % i

${ir.uses.has('object_size') ? `# every object using this material gets its size (bounding box diagonal); run again after resizing an object
for o in bpy.data.objects:
    if o.type == "MESH" and any(sl.material == m for sl in o.material_slots):
        o["inoscula_object_size"] = o.dimensions.length
` : ''}print("Inoscula: built material " + MAT)
`
}
