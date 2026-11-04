// Native node graphs: the shader rebuilt from each program's own nodes (Godot VisualShader, Unreal material
// expressions, Unity Shader Graph). Maths become the program's maths nodes one for one; the parts no program has
// a node for (Blender's noise, Voronoi and white noise, colour ramps, safe divide and power) become one small code
// node each (Godot Expression, Unreal Custom, Unity Custom Function) that runs the same maths as every other target.
import { helperParts, helpers, LANG, num, type Lang } from './code.ts'
import { toUnreal } from './targets/hlsl.ts'
import type { Arg, IR, Step } from './spec.ts'
import type { GIn, GLink, GNode, NodeView, SockType } from './nodes.ts'

type Target = 'godot' | 'unreal' | 'unity'
export interface NNode extends GNode {
  /** What the program calls the node class, and its settings. */
  cls: string
  props: Record<string, unknown>
  /** Code nodes: their code, with inputs and outputs named as the code uses them. */
  code?: string
  ports?: { ins: [string, SockType][]; outs: [string, SockType][] }
}
export interface Native { nodes: NNode[]; links: GLink[]; out: string; target: Target }

const TAU = 6.283185307179586
const st = (t: string): SockType => (t === 'vec3' ? 'vec3' : 'float')

// the names each program gives its nodes, inputs and outputs
const NATIVE_NAMES: Record<Target, Record<string, { title: string; cls: string; ins: string[]; out: string; props?: Record<string, unknown>; note?: string }>> = {
  godot: {
    add_f: { title: 'FloatOp', cls: 'VisualShaderNodeFloatOp', ins: ['a', 'b'], out: 'op', props: { operator: 0 }, note: 'Add' },
    sub_f: { title: 'FloatOp', cls: 'VisualShaderNodeFloatOp', ins: ['a', 'b'], out: 'op', props: { operator: 1 }, note: 'Subtract' },
    mul_f: { title: 'FloatOp', cls: 'VisualShaderNodeFloatOp', ins: ['a', 'b'], out: 'op', props: { operator: 2 }, note: 'Multiply' },
    div_f: { title: 'FloatOp', cls: 'VisualShaderNodeFloatOp', ins: ['a', 'b'], out: 'op', props: { operator: 3 }, note: 'Divide' },
    max_f: { title: 'FloatOp', cls: 'VisualShaderNodeFloatOp', ins: ['a', 'b'], out: 'op', props: { operator: 6 }, note: 'Max' },
    min_f: { title: 'FloatOp', cls: 'VisualShaderNodeFloatOp', ins: ['a', 'b'], out: 'op', props: { operator: 7 }, note: 'Min' },
    atan2_f: { title: 'FloatOp', cls: 'VisualShaderNodeFloatOp', ins: ['a', 'b'], out: 'op', props: { operator: 8 }, note: 'Atan2' },
    add_v: { title: 'VectorOp', cls: 'VisualShaderNodeVectorOp', ins: ['a', 'b'], out: 'op', props: { op_type: 1, operator: 0 }, note: 'Add' },
    sub_v: { title: 'VectorOp', cls: 'VisualShaderNodeVectorOp', ins: ['a', 'b'], out: 'op', props: { op_type: 1, operator: 1 }, note: 'Subtract' },
    mul_v: { title: 'VectorOp', cls: 'VisualShaderNodeVectorOp', ins: ['a', 'b'], out: 'op', props: { op_type: 1, operator: 2 }, note: 'Multiply' },
    div_v: { title: 'VectorOp', cls: 'VisualShaderNodeVectorOp', ins: ['a', 'b'], out: 'op', props: { op_type: 1, operator: 3 }, note: 'Divide' },
    max_v: { title: 'VectorOp', cls: 'VisualShaderNodeVectorOp', ins: ['a', 'b'], out: 'op', props: { op_type: 1, operator: 6 }, note: 'Max' },
    min_v: { title: 'VectorOp', cls: 'VisualShaderNodeVectorOp', ins: ['a', 'b'], out: 'op', props: { op_type: 1, operator: 7 }, note: 'Min' },
    abs_f: { title: 'FloatFunc', cls: 'VisualShaderNodeFloatFunc', ins: [''], out: '', props: { function: 12 }, note: 'Abs' },
    floor_f: { title: 'FloatFunc', cls: 'VisualShaderNodeFloatFunc', ins: [''], out: '', props: { function: 14 }, note: 'Floor' },
    fract_f: { title: 'FloatFunc', cls: 'VisualShaderNodeFloatFunc', ins: [''], out: '', props: { function: 17 }, note: 'Fract' },
    sin_f: { title: 'FloatFunc', cls: 'VisualShaderNodeFloatFunc', ins: [''], out: '', props: { function: 0 }, note: 'Sin' },
    cos_f: { title: 'FloatFunc', cls: 'VisualShaderNodeFloatFunc', ins: [''], out: '', props: { function: 1 }, note: 'Cos' },
    exp_f: { title: 'FloatFunc', cls: 'VisualShaderNodeFloatFunc', ins: [''], out: '', props: { function: 10 }, note: 'Exp' },
    one_minus_f: { title: 'FloatFunc', cls: 'VisualShaderNodeFloatFunc', ins: [''], out: '', props: { function: 31 }, note: 'OneMinus' },
    saturate_f: { title: 'FloatFunc', cls: 'VisualShaderNodeFloatFunc', ins: [''], out: '', props: { function: 18 }, note: 'Saturate' },
    abs_v: { title: 'VectorFunc', cls: 'VisualShaderNodeVectorFunc', ins: [''], out: '', props: { op_type: 1, function: 4 }, note: 'Abs' },
    floor_v: { title: 'VectorFunc', cls: 'VisualShaderNodeVectorFunc', ins: [''], out: '', props: { op_type: 1, function: 17 }, note: 'Floor' },
    fract_v: { title: 'VectorFunc', cls: 'VisualShaderNodeVectorFunc', ins: [''], out: '', props: { op_type: 1, function: 18 }, note: 'Fract' },
    sin_v: { title: 'VectorFunc', cls: 'VisualShaderNodeVectorFunc', ins: [''], out: '', props: { op_type: 1, function: 26 }, note: 'Sin' },
    cos_v: { title: 'VectorFunc', cls: 'VisualShaderNodeVectorFunc', ins: [''], out: '', props: { op_type: 1, function: 12 }, note: 'Cos' },
    exp_v: { title: 'VectorFunc', cls: 'VisualShaderNodeVectorFunc', ins: [''], out: '', props: { op_type: 1, function: 15 }, note: 'Exp' },
    one_minus_v: { title: 'VectorFunc', cls: 'VisualShaderNodeVectorFunc', ins: [''], out: '', props: { op_type: 1, function: 32 }, note: 'OneMinus' },
    normalize_v: { title: 'VectorFunc', cls: 'VisualShaderNodeVectorFunc', ins: [''], out: '', props: { op_type: 1, function: 0 }, note: 'Normalize' },
    clamp_f: { title: 'Clamp', cls: 'VisualShaderNodeClamp', ins: ['', 'min', 'max'], out: '', props: { op_type: 0 } },
    clamp_v: { title: 'Clamp', cls: 'VisualShaderNodeClamp', ins: ['', 'min', 'max'], out: '', props: { op_type: 4 } },
    mix_f: { title: 'Mix', cls: 'VisualShaderNodeMix', ins: ['a', 'b', 'weight'], out: 'mix', props: { op_type: 0 } },
    mix_v: { title: 'Mix', cls: 'VisualShaderNodeMix', ins: ['a', 'b', 'weight'], out: 'mix', props: { op_type: 4 } },
    smoothstep_f: { title: 'SmoothStep', cls: 'VisualShaderNodeSmoothStep', ins: ['edge0', 'edge1', 'x'], out: '', props: { op_type: 0 } },
    dot_f: { title: 'DotProduct', cls: 'VisualShaderNodeDotProduct', ins: ['a', 'b'], out: 'dot' },
    length_f: { title: 'VectorLen', cls: 'VisualShaderNodeVectorLen', ins: [''], out: 'length' },
    combine_v: { title: 'VectorCompose', cls: 'VisualShaderNodeVectorCompose', ins: ['x', 'y', 'z'], out: 'vec', props: { op_type: 1 } },
  },
  unreal: {
    add_f: { title: 'Add', cls: 'MaterialExpressionAdd', ins: ['A', 'B'], out: '' },
    sub_f: { title: 'Subtract', cls: 'MaterialExpressionSubtract', ins: ['A', 'B'], out: '' },
    mul_f: { title: 'Multiply', cls: 'MaterialExpressionMultiply', ins: ['A', 'B'], out: '' },
    div_f: { title: 'Divide', cls: 'MaterialExpressionDivide', ins: ['A', 'B'], out: '' },
    max_f: { title: 'Max', cls: 'MaterialExpressionMax', ins: ['A', 'B'], out: '' },
    min_f: { title: 'Min', cls: 'MaterialExpressionMin', ins: ['A', 'B'], out: '' },
    atan2_f: { title: 'Arctangent2', cls: 'MaterialExpressionArctangent2', ins: ['Y', 'X'], out: '' },
    abs_f: { title: 'Abs', cls: 'MaterialExpressionAbs', ins: [''], out: '' },
    floor_f: { title: 'Floor', cls: 'MaterialExpressionFloor', ins: [''], out: '' },
    fract_f: { title: 'Frac', cls: 'MaterialExpressionFrac', ins: [''], out: '' },
    sin_f: { title: 'Sine', cls: 'MaterialExpressionSine', ins: [''], out: '', props: { period: TAU }, note: 'Period 6.2832' },
    cos_f: { title: 'Cosine', cls: 'MaterialExpressionCosine', ins: [''], out: '', props: { period: TAU }, note: 'Period 6.2832' },
    one_minus_f: { title: '1-x', cls: 'MaterialExpressionOneMinus', ins: [''], out: '' },
    saturate_f: { title: 'Saturate', cls: 'MaterialExpressionSaturate', ins: [''], out: '' },
    normalize_v: { title: 'Normalize', cls: 'MaterialExpressionNormalize', ins: [''], out: '' },
    clamp_f: { title: 'Clamp', cls: 'MaterialExpressionClamp', ins: ['', 'Min', 'Max'], out: '' },
    mix_f: { title: 'Lerp', cls: 'MaterialExpressionLinearInterpolate', ins: ['A', 'B', 'Alpha'], out: '' },
    smoothstep_f: { title: 'SmoothStep', cls: 'MaterialExpressionSmoothStep', ins: ['Min', 'Max', 'Value'], out: '' },
    dot_f: { title: 'Dot', cls: 'MaterialExpressionDotProduct', ins: ['A', 'B'], out: '' },
    length_f: { title: 'Length', cls: 'MaterialExpressionLength', ins: [''], out: '' },
  },
  unity: {
    add_f: { title: 'Add', cls: 'AddNode', ins: ['A', 'B'], out: 'Out' },
    sub_f: { title: 'Subtract', cls: 'SubtractNode', ins: ['A', 'B'], out: 'Out' },
    mul_f: { title: 'Multiply', cls: 'MultiplyNode', ins: ['A', 'B'], out: 'Out' },
    div_f: { title: 'Divide', cls: 'DivideNode', ins: ['A', 'B'], out: 'Out' },
    max_f: { title: 'Maximum', cls: 'MaximumNode', ins: ['A', 'B'], out: 'Out' },
    min_f: { title: 'Minimum', cls: 'MinimumNode', ins: ['A', 'B'], out: 'Out' },
    atan2_f: { title: 'Arctangent2', cls: 'Arctangent2Node', ins: ['A', 'B'], out: 'Out' },
    abs_f: { title: 'Absolute', cls: 'AbsoluteNode', ins: ['In'], out: 'Out' },
    floor_f: { title: 'Floor', cls: 'FloorNode', ins: ['In'], out: 'Out' },
    fract_f: { title: 'Fraction', cls: 'FractionNode', ins: ['In'], out: 'Out' },
    sin_f: { title: 'Sine', cls: 'SineNode', ins: ['In'], out: 'Out' },
    cos_f: { title: 'Cosine', cls: 'CosineNode', ins: ['In'], out: 'Out' },
    exp_f: { title: 'Exponential', cls: 'ExponentialNode', ins: ['In'], out: 'Out', note: 'Base E' },
    one_minus_f: { title: 'One Minus', cls: 'OneMinusNode', ins: ['In'], out: 'Out' },
    saturate_f: { title: 'Saturate', cls: 'SaturateNode', ins: ['In'], out: 'Out' },
    normalize_v: { title: 'Normalize', cls: 'NormalizeNode', ins: ['In'], out: 'Out' },
    clamp_f: { title: 'Clamp', cls: 'ClampNode', ins: ['In', 'Min', 'Max'], out: 'Out' },
    mix_f: { title: 'Lerp', cls: 'LerpNode', ins: ['A', 'B', 'T'], out: 'Out' },
    smoothstep_f: { title: 'Smoothstep', cls: 'SmoothstepNode', ins: ['Edge1', 'Edge2', 'In'], out: 'Out' },
    dot_f: { title: 'Dot Product', cls: 'DotProductNode', ins: ['A', 'B'], out: 'Out' },
    length_f: { title: 'Length', cls: 'LengthNode', ins: ['In'], out: 'Out' },
    combine_v: { title: 'Combine', cls: 'CombineNode', ins: ['R', 'G', 'B'], out: 'RGB' },
  },
}

const LANGS: Record<Target, Lang> = { godot: LANG.godot, unreal: LANG.hlsl, unity: LANG.hlsl }

export function nativeGraph(ir: IR, target: Target): Native {
  const L = LANGS[target], names = NATIVE_NAMES[target]
  const nodes: NNode[] = [], links: GLink[] = []
  const sock = new Map<string, [string, number]>()
  let n = 0
  const add = (x: Omit<NNode, 'id'> & { id?: string }): NNode => { const node = { ...x, id: x.id ?? 'n' + n++ } as NNode; nodes.push(node); return node }
  const realType = (a: Arg): SockType => {
    if (a.k !== 'ref') return st(a.type)
    if (/_(x|y|z)$/.test(a.id)) return 'float'
    const s = ir.steps.find((q) => q.id === a.id.replace(/_(color|position)$/, ''))
    if (s) return /_(color|position)$/.test(a.id) ? 'vec3' : st(s.type)
    const p = ir.params.find((q) => 'p_' + q.id === a.id)
    return p ? st(p.t) : st(a.type)
  }
  // ---- inputs: one code node turns the program's own positions, normals and time into Inoscula's space
  const SRC: [string, string, SockType][] = [['uv', 'uv', 'vec3'], ['object_pos', 'object_pos', 'vec3'], ['object_normal', 'object_normal', 'vec3'], ['world_pos', 'world_pos', 'vec3'], ['normal', 'normal', 'vec3'], ['view_dir', 'view_dir', 'vec3'], ['light_dir', 'light_dir', 'vec3'], ['light_color', 'light_color', 'vec3'], ['curvature', 'curvature', 'float'], ['occlusion', 'occlusion', 'float'], ['object_size', 'object_size', 'float']]
  const used = SRC.filter(([op]) => ir.uses.has(op))
  const srcCode: Record<Target, Record<string, string>> = {
    godot: {
      uv: 'vec3(UV.x, 1.0 - UV.y, 0.0)',
      world_pos: 'inoscula_canon((INV_VIEW_MATRIX * vec4(VERTEX, 1.0)).xyz)',
      normal: 'inoscula_canon(normalize((INV_VIEW_MATRIX * vec4(NORMAL, 0.0)).xyz))',
      object_pos: 'inoscula_canon((inverse(MODEL_MATRIX) * INV_VIEW_MATRIX * vec4(VERTEX, 1.0)).xyz)',
      object_normal: 'inoscula_canon(normalize((inverse(MODEL_MATRIX) * INV_VIEW_MATRIX * vec4(NORMAL, 0.0)).xyz))',
      view_dir: 'inoscula_canon(normalize(CAMERA_POSITION_WORLD - (INV_VIEW_MATRIX * vec4(VERTEX, 1.0)).xyz))',
      light_dir: 'inoscula_canon(normalize(light_dir_in))',
      light_color: 'light_color_in',
      curvature: 'mix(0.5, COLOR.r, inoscula_has_shape(COLOR.rgb))',
      occlusion: 'mix(1.0, COLOR.g, inoscula_has_shape(COLOR.rgb))',
      object_size: 'object_size_in',
    },
    unreal: {
      uv: 'float3(UV.x, 1.0 - UV.y, 0.0)', world_pos: 'float3(WPos.x, -WPos.y, WPos.z) * 0.01', normal: 'normalize(float3(WNrm.x, -WNrm.y, WNrm.z))',
      object_pos: 'float3(ObjPos.x, -ObjPos.y, ObjPos.z) * 0.01', object_normal: 'normalize(float3(ObjNrm.x, -ObjNrm.y, ObjNrm.z))', view_dir: 'normalize(float3(CamVec.x, -CamVec.y, CamVec.z))',
      light_dir: 'normalize(float3(LightDir.x, -LightDir.y, LightDir.z))', light_color: 'LightColor', curvature: 'lerp(0.5, VCol.x, abs(VCol.z - 0.5) < 0.3 ? 1.0 : 0.0)', occlusion: 'lerp(1.0, VCol.y, abs(VCol.z - 0.5) < 0.3 ? 1.0 : 0.0)', object_size: 'ObjRadius * 0.02',
    },
    unity: {
      uv: 'float3(UV.x, UV.y, 0.0)', world_pos: 'WorldPosition.xzy', normal: 'normalize(WorldNormal.xzy)', object_pos: 'ObjectPosition.xzy', object_normal: 'normalize(ObjectNormal.xzy)', view_dir: 'normalize(ViewDirection.xzy)',
      light_dir: 'normalize(LightDirection.xzy)', light_color: 'LightColor', curvature: 'lerp(0.5, VertexColor.x, abs(VertexColor.z - 0.5) < 0.3 ? 1.0 : 0.0)', occlusion: 'lerp(1.0, VertexColor.y, abs(VertexColor.z - 0.5) < 0.3 ? 1.0 : 0.0)', object_size: 'ObjectSize',
    },
  }
  const nativeIns: Record<Target, Record<string, [string, SockType, string][]>> = {
    // [input name on the code node, type, where it comes from]
    godot: { light_dir: [['light_dir_in', 'vec3', 'inoscula_light_dir']], light_color: [['light_color_in', 'vec3', 'inoscula_light_color']], object_size: [['object_size_in', 'float', 'inoscula_object_size']] },
    unreal: { uv: [['UV', 'vec3', 'TextureCoordinate']], world_pos: [['WPos', 'vec3', 'WorldPosition']], normal: [['WNrm', 'vec3', 'VertexNormalWS']], object_pos: [['ObjPos', 'vec3', 'LocalPosition']], object_normal: [['ObjNrm', 'vec3', 'VertexNormalWS']], view_dir: [['CamVec', 'vec3', 'CameraVectorWS']], light_dir: [['LightDir', 'vec3', 'Inoscula Light Direction']], light_color: [['LightColor', 'vec3', 'Inoscula Light Color']], curvature: [['VCol', 'vec3', 'VertexColor']], occlusion: [['VCol', 'vec3', 'VertexColor']], object_size: [['ObjRadius', 'float', 'ObjectRadius']] },
    unity: { uv: [['UV', 'vec3', 'UV']], world_pos: [['WorldPosition', 'vec3', 'Position (World)']], normal: [['WorldNormal', 'vec3', 'Normal Vector (World)']], object_pos: [['ObjectPosition', 'vec3', 'Position (Object)']], object_normal: [['ObjectNormal', 'vec3', 'Normal Vector (Object)']], view_dir: [['ViewDirection', 'vec3', 'View Direction (World)']], light_dir: [['LightDirection', 'vec3', 'Inoscula Light Direction']], light_color: [['LightColor', 'vec3', 'Inoscula Light Color']], curvature: [['VertexColor', 'vec3', 'Vertex Color']], occlusion: [['VertexColor', 'vec3', 'Vertex Color']], object_size: [['ObjectSize', 'float', 'Object (Bounds Size length)']] },
  }
  const codeTitle = { godot: 'Expression', unreal: 'Custom', unity: 'Custom Function' }[target]
  const codeCls = { godot: 'VisualShaderNodeExpression', unreal: 'MaterialExpressionCustom', unity: 'CustomFunctionNode' }[target]
  if (used.length || ir.uses.has('time')) {
    if (ir.uses.has('time')) {
      const t = target === 'godot' ? add({ title: 'Input', cls: 'VisualShaderNodeInput', cat: 'input', props: { input_name: 'time' }, ins: [], outs: [{ n: 'time', t: 'float' }] })
        : target === 'unreal' ? add({ title: 'Time', cls: 'MaterialExpressionTime', cat: 'input', props: {}, ins: [], outs: [{ n: '', t: 'float' }] })
          : add({ title: 'Time', cls: 'TimeNode', cat: 'input', props: {}, ins: [], outs: [{ n: 'Time', t: 'float' }] })
      sock.set('time', [t.id, 0])
    }
    const srcs = used.filter(([op]) => op !== 'time')
    if (srcs.length) {
      const inPins = new Map<string, [string, SockType, string]>()
      for (const [op] of srcs) for (const p of nativeIns[target][op] ?? []) inPins.set(p[0], p)
      const pins = [...inPins.values()]
      const outs = srcs.map(([op, , t]) => [op, t] as [string, SockType])
      const code = target === 'godot'
        ? outs.map(([op]) => `${op} = ${srcCode.godot[op]};`).join('\n')
        : target === 'unreal' ? outs.slice(1).map(([op]) => `${op} = ${srcCode.unreal[op]};`).join('\n') + `\nreturn ${srcCode.unreal[outs[0][0]]};`
          : outs.map(([op]) => `${op} = ${srcCode.unity[op]};`).join('\n')
      const node = add({ title: codeTitle, cls: codeCls, cat: 'custom', props: { description: 'Inoscula inputs' }, note: 'Inoscula inputs (Z up, metres)', code, ports: { ins: pins.map(([n, t]) => [n, t]), outs },
        ins: pins.map(([nm, t]) => ({ n: nm, t })), outs: outs.map(([nm, t]) => ({ n: nm, t })) })
      outs.forEach(([op], i) => sock.set(op, [node.id, i]))
      // what feeds the code node
      pins.forEach(([, t, from], i) => {
        let src: NNode
        if (target === 'godot') {
          src = add({ title: from, cls: from === 'inoscula_object_size' ? 'VisualShaderNodeFloatParameter' : 'VisualShaderNodeVec3Parameter', cat: 'param', props: from === 'inoscula_object_size' ? { parameter_name: from, qualifier: 2, default_value_enabled: true, default_value: 2 } : { parameter_name: from, default_value_enabled: true, default_value: from.endsWith('dir') ? [0.4, 0.8, 0.45] : [1, 1, 1] }, ins: [], outs: [{ n: '', t }], note: from === 'inoscula_object_size' ? 'instance parameter' : 'set by the light bridge' })
        } else if (target === 'unreal') {
          const isParam = from.startsWith('Inoscula')
          src = add({ title: isParam ? from : from.replace(/([a-z])([A-Z])/g, '$1 $2'), cls: isParam ? 'MaterialExpressionVectorParameter' : 'MaterialExpression' + from, cat: isParam ? 'param' : 'input', props: isParam ? { parameter_name: from, default_value: from.endsWith('Direction') ? [0.4, -0.45, 0.8] : [1, 1, 1] } : {}, ins: [], outs: [{ n: '', t }] })
        } else {
          src = add({ title: from, cls: 'Node', cat: from.startsWith('Inoscula') ? 'param' : 'input', props: {}, ins: [], outs: [{ n: 'Out', t }] })
        }
        links.push({ a: src.id, ao: 0, b: node.id, bi: i })
      })
    }
  }
  // ---- parameters
  const paramNode = (id: string) => {
    if (sock.has(id)) return
    const p = ir.params.find((q) => 'p_' + q.id === id)!
    const label = p.label ?? p.id
    let node: NNode
    if (target === 'godot') {
      const cls = p.t === 'float' ? 'VisualShaderNodeFloatParameter' : p.type === 'color' ? 'VisualShaderNodeColorParameter' : 'VisualShaderNodeVec3Parameter'
      const props: Record<string, unknown> = { parameter_name: 'p_' + p.id, default_value_enabled: true, default_value: p.default }
      if (p.t === 'float' && p.min !== undefined && p.max !== undefined) Object.assign(props, { hint: 1, min: p.min, max: p.max })
      node = add({ title: cls.replace('VisualShaderNode', ''), cls, cat: 'param', props, ins: [], outs: [{ n: 'p_' + p.id, t: p.type === 'color' ? 'color' : st(p.t) }], note: label })
    } else if (target === 'unreal') {
      node = add({ title: label, cls: p.t === 'float' ? 'MaterialExpressionScalarParameter' : 'MaterialExpressionVectorParameter', cat: 'param', props: { parameter_name: label, default_value: p.default, ...(p.t === 'float' && p.min !== undefined ? { slider_min: p.min, slider_max: p.max } : {}) }, ins: [], outs: [{ n: p.t === 'float' ? '' : 'RGB', t: p.type === 'color' ? 'color' : st(p.t) }], note: p.t === 'float' ? 'Param' : 'Param (Vector)' })
    } else {
      node = add({ title: label, cls: 'PropertyNode', cat: 'param', props: {}, ins: [], outs: [{ n: p.t === 'float' ? 'Float' : p.type === 'color' ? 'Color' : 'Vector3', t: p.type === 'color' ? 'color' : st(p.t) }], note: 'Blackboard property' })
    }
    sock.set(id, [node.id, 0])
  }
  const feed = (a: Arg | undefined, node: NNode, i: number) => {
    if (!a) return
    if (a.k === 'lit') { node.ins[i].v = a.v; return }
    const base = a.id
    if (base.startsWith('p_')) paramNode(base)
    const s = sock.get(base)
    if (s) links.push({ a: s[0], ao: s[1], b: node.id, bi: i })
  }
  const nat = (key: string, s: Step, extra?: Partial<NNode>) => {
    const d = names[key]
    // a node's inputs take its own kind: vector maths takes vectors (a float wired in is spread), except a mix amount
    const inT = (i: number): SockType => (s.op === 'dot' || s.op === 'length' || s.op === 'normalize') ? 'vec3' : s.op === 'combine' || s.op === 'smoothstep' ? 'float' : s.type === 'vec3' && !(s.op === 'mix' && i === 2) ? 'vec3' : 'float'
    const node = add({ title: d.title, cls: d.cls, cat: 'converter', props: { ...(d.props ?? {}) }, note: d.note, ins: d.ins.map((nm, i) => ({ n: nm, t: inT(i) })), outs: [{ n: d.out, t: st(s.type) }], ...extra })
    s.args.forEach((a, i) => feed(a, node, i))
    sock.set(s.id, [node.id, 0])
    return node
  }
  const codeNode = (s: Step, title: string, expr: (ins: string[]) => string, ins: [string, SockType][], outs: [string, SockType][]) => {
    const insN = ins.map(([nm]) => nm)
    const code = target === 'unreal'
      ? outs.slice(1).map(([o], k) => `${o} = ${expr(insN).split('\n')[k + 1] ?? ''};`).join('\n') + `return ${expr(insN).split('\n')[0]};`
      : outs.length === 1 ? `${outs[0][0]} = ${expr(insN)};` : expr(insN)
    const node = add({ title: codeTitle, cls: codeCls, cat: 'custom', props: { description: title, op: s.op, step: s.id, vec: s.type === 'vec3' }, note: title, code, ports: { ins, outs }, ins: ins.map(([nm, t]) => ({ n: nm, t })), outs: outs.map(([nm, t]) => ({ n: nm, t })) })
    s.args.forEach((a, i) => feed(a, node, i))
    outs.forEach((_, i) => sock.set(i === 0 ? s.id : `${s.id}_${['', 'color', 'position'][i]}`, [node.id, i]))
    return node
  }
  const v3 = L.ty('vec3')
  for (const s of ir.steps) {
    const v = s.type === 'vec3', k = (op: string) => `${op}_${v ? 'v' : 'f'}`
    // targets that have one node for float and vector maths
    const key = (op: string) => names[k(op)] ? k(op) : names[op + '_f'] ? op + '_f' : null
    const safeDivisor = s.op === 'div' && s.args[1]?.k === 'lit' && (Array.isArray(s.args[1].v) ? (s.args[1].v as number[]).every((x) => x !== 0) : s.args[1].v !== 0)
    switch (s.op) {
      case 'param': break
      case 'value':
        if (target === 'godot') { const node = add({ title: v ? 'Vector3Constant' : 'FloatConstant', cls: v ? 'VisualShaderNodeVec3Constant' : 'VisualShaderNodeFloatConstant', cat: 'input', props: { constant: s.set.v }, ins: [], outs: [{ n: '', t: st(s.type) }], note: String(s.set.v) }); sock.set(s.id, [node.id, 0]) }
        else if (target === 'unreal') { const node = add({ title: v ? 'Constant3Vector' : 'Constant', cls: v ? 'MaterialExpressionConstant3Vector' : 'MaterialExpressionConstant', cat: 'input', props: v ? { constant: s.set.v } : { r: s.set.v }, ins: [], outs: [{ n: '', t: st(s.type) }], note: String(s.set.v) }); sock.set(s.id, [node.id, 0]) }
        else { const node = add({ title: v ? 'Vector 3' : 'Float', cls: v ? 'Vector3Node' : 'Vector1Node', cat: 'input', props: { value: s.set.v }, ins: [], outs: [{ n: 'Out', t: st(s.type) }], note: String(s.set.v) }); sock.set(s.id, [node.id, 0]) }
        break
      case 'add': case 'sub': case 'mul': case 'min': case 'max': case 'abs': case 'floor': case 'fract': case 'sin': case 'cos': case 'one_minus': case 'exp': case 'atan2': case 'smoothstep': case 'dot': case 'length': case 'normalize': case 'clamp': {
        const kk = key(s.op)
        if (kk) { nat(kk, s); break }
        // no node for it here (Godot has no vector Clamp with float limits that we need; keep it exact in code)
        codeNode(s, s.op, (a) => ({ clamp: `min(max(${a[0]}, ${a[1]}), ${a[2]})` } as Record<string, string>)[s.op] ?? `${s.op}(${a.join(', ')})`, s.args.map((x, i) => [['x', 'lo', 'hi'][i] ?? 'x' + i, realType(x)]), [['out', st(s.type)]])
        break
      }
      case 'div':
        if (safeDivisor && key('div')) { nat(key('div')!, s); break }
        codeNode(s, 'Divide (0 where b is 0)', (a) => `inoscula_div_${v ? 'v' : 'f'}(${v ? `${v3}(${a[0]})` : a[0]}, ${v ? `${v3}(${a[1]})` : a[1]})`, [['a', realType(s.args[0])], ['b', realType(s.args[1])]], [['out', st(s.type)]]); break
      case 'pow':
        codeNode(s, 'Power (safe)', (a) => `inoscula_pow_${v ? 'v' : 'f'}(${v ? `${v3}(${a[0]})` : a[0]}, ${v ? `${v3}(${a[1]})` : a[1]})`, [['a', realType(s.args[0])], ['b', realType(s.args[1])]], [['out', st(s.type)]]); break
      case 'sqrt':
        codeNode(s, 'Square Root (safe)', (a) => `inoscula_sqrt_${v ? 'v' : 'f'}(${a[0]})`, [['x', st(s.type)]], [['out', st(s.type)]]); break
      case 'greater':
        if (target === 'unreal') {
          const node = add({ title: 'If', cls: 'MaterialExpressionIf', cat: 'converter', props: {}, note: 'A > B gives 1', ins: [{ n: 'A', t: 'float' }, { n: 'B', t: 'float' }, { n: 'A > B', t: 'float', v: 1 }, { n: 'A == B', t: 'float', v: 0 }, { n: 'A < B', t: 'float', v: 0 }], outs: [{ n: '', t: 'float' }] })
          feed(s.args[0], node, 0); feed(s.args[1], node, 1); sock.set(s.id, [node.id, 0]); break
        }
        if (target === 'unity') {
          const node = add({ title: 'Comparison', cls: 'ComparisonNode', cat: 'converter', props: {}, note: 'Greater', ins: [{ n: 'A', t: 'float' }, { n: 'B', t: 'float' }], outs: [{ n: 'Out', t: 'float' }] })
          feed(s.args[0], node, 0); feed(s.args[1], node, 1)
          const br = add({ title: 'Branch', cls: 'BranchNode', cat: 'converter', props: {}, ins: [{ n: 'Predicate', t: 'float' }, { n: 'True', t: 'float', v: 1 }, { n: 'False', t: 'float', v: 0 }], outs: [{ n: 'Out', t: 'float' }] })
          links.push({ a: node.id, ao: 0, b: br.id, bi: 0 }); sock.set(s.id, [br.id, 0]); break
        }
        codeNode(s, 'Greater Than', (a) => `${a[0]} > ${a[1]} ? 1.0 : 0.0`, [['a', 'float'], ['b', 'float']], [['out', 'float']]); break
      case 'mix': {
        // the blend amount is clamped, as in Blender's Mix node
        const tArg = s.args[2]
        const kk = names[k('mix')] ? k('mix') : 'mix_f'
        const node = nat(kk, s)
        if (tArg.k === 'ref') {
          links.splice(links.findIndex((l) => l.b === node.id && l.bi === 2), 1)
          const sat = add({ title: names.saturate_f.title, cls: names.saturate_f.cls, cat: 'converter', props: { ...(names.saturate_f.props ?? {}) }, note: names.saturate_f.note, ins: [{ n: names.saturate_f.ins[0], t: 'float' }], outs: [{ n: names.saturate_f.out, t: 'float' }] })
          feed(tArg, sat, 0)
          links.push({ a: sat.id, ao: 0, b: node.id, bi: 2 })
        } else node.ins[2].v = Math.max(0, Math.min(1, tArg.v as number))
        break
      }
      case 'combine':
        if (target === 'unreal') {
          const ab = add({ title: 'Append', cls: 'MaterialExpressionAppendVector', cat: 'vector', props: {}, ins: [{ n: 'A', t: 'float' }, { n: 'B', t: 'float' }], outs: [{ n: '', t: 'vec3' }] })
          const abc = add({ title: 'Append', cls: 'MaterialExpressionAppendVector', cat: 'vector', props: {}, ins: [{ n: 'A', t: 'vec3' }, { n: 'B', t: 'float' }], outs: [{ n: '', t: 'vec3' }] })
          feed(s.args[0], ab, 0); feed(s.args[1], ab, 1); links.push({ a: ab.id, ao: 0, b: abc.id, bi: 0 }); feed(s.args[2], abc, 1)
          sock.set(s.id, [abc.id, 0]); break
        }
        nat('combine_v', s); break
      case 'separate':
        if (target === 'godot') {
          const node = add({ title: 'VectorDecompose', cls: 'VisualShaderNodeVectorDecompose', cat: 'converter', props: { op_type: 1 }, ins: [{ n: 'vec', t: 'vec3' }], outs: [{ n: 'x', t: 'float' }, { n: 'y', t: 'float' }, { n: 'z', t: 'float' }] })
          feed(s.args[0], node, 0); ['x', 'y', 'z'].forEach((c, i) => sock.set(`${s.id}_${c}`, [node.id, i])); break
        }
        if (target === 'unity') {
          const node = add({ title: 'Split', cls: 'SplitNode', cat: 'converter', props: {}, ins: [{ n: 'In', t: 'vec3' }], outs: [{ n: 'R', t: 'float' }, { n: 'G', t: 'float' }, { n: 'B', t: 'float' }] })
          feed(s.args[0], node, 0); ['x', 'y', 'z'].forEach((c, i) => sock.set(`${s.id}_${c}`, [node.id, i])); break
        }
        ;['x', 'y', 'z'].forEach((c, i) => {
          const node = add({ title: 'Mask (' + 'RGB'[i] + ')', cls: 'MaterialExpressionComponentMask', cat: 'vector', props: { r: i === 0, g: i === 1, b: i === 2 }, ins: [{ n: '', t: 'vec3' }], outs: [{ n: '', t: 'float' }] })
          feed(s.args[0], node, 0); sock.set(`${s.id}_${c}`, [node.id, 0])
        })
        break
      case 'noise':
        codeNode(s, 'Noise Texture (Blender maths)', (a) => `inoscula_noise(${a.join(', ')})`, [['p', 'vec3'], ['scale', 'float'], ['detail', 'float'], ['roughness', 'float'], ['lacunarity', 'float']], [['fac', 'float']]); break
      case 'white_noise':
        codeNode(s, 'White Noise (Blender maths)', (a) => `inoscula_white(${a[0]})`, [['p', 'vec3']], [['value', 'float']]); break
      case 'voronoi':
        codeNode(s, 'Voronoi Texture (Blender maths)', (a) => target === 'unreal'
          ? `d\ncol\npos`.replace('d', `inoscula_voronoi_d(${a.join(', ')})`).replace('col', `inoscula_voronoi_c(${a.join(', ')})`).replace('pos', `inoscula_voronoi_p(${a.join(', ')})`)
          : `inoscula_voronoi(${a.join(', ')}, distance, color, position);`, [['p', 'vec3'], ['scale', 'float'], ['randomness', 'float']], [['distance', 'float'], ['color', 'vec3'], ['position', 'vec3']]); break
      case 'ramp':
        codeNode(s, 'Colour Ramp', (a) => `inoscula_ramp_${s.id}(${a[0]})`, [['t', 'float']], [['color', 'vec3']]); break
      default: {
        if (!sock.has(s.op)) throw new Error(`${target} nodes: no node for ${s.op}`)
        sock.set(s.id, sock.get(s.op)!)
      }
    }
  }
  // ---- the output node
  const outs: [string, Arg | null, number | string, SockType, boolean?][] = target === 'godot'
    ? [['Albedo', ir.color, 0, 'vec3'], ['Alpha', ir.alpha, 1, 'float'], ...(ir.lit ? [['Metallic', ir.metallic, 2, 'float', true], ['Roughness', ir.roughness, 3, 'float', true], ['Emission', ir.emission, 5, 'vec3'], ['Clearcoat', ir.layers.coat, 13, 'float', true], ['Clearcoat Roughness', ir.layers.coat_roughness, 14, 'float', true], ['Rim', ir.layers.sheen, 11, 'float', true], ['SSS Strength', ir.layers.subsurface, 17, 'float', true]] as [string, Arg | null, number, SockType, boolean?][] : [])]
    : target === 'unreal'
      ? [[ir.lit ? 'Base Color' : 'Emissive Color', ir.color, ir.lit ? 'MP_BASE_COLOR' : 'MP_EMISSIVE_COLOR', 'vec3'], [ir.cutout ? 'Opacity Mask' : 'Opacity', ir.alpha, ir.cutout ? 'MP_OPACITY_MASK' : 'MP_OPACITY', 'float'], ...(ir.lit ? [['Metallic', ir.metallic, 'MP_METALLIC', 'float', true], ['Roughness', ir.roughness, 'MP_ROUGHNESS', 'float', true], ['Emissive Color', ir.emission, 'MP_EMISSIVE_COLOR', 'vec3']] as [string, Arg | null, string, SockType, boolean?][] : [])]
      : [['Base Color', ir.color, 'BaseColor', 'vec3'], ['Alpha', ir.alpha, 'Alpha', 'float'], ...(ir.lit ? [['Metallic', ir.metallic, 'Metallic', 'float', true], ['Smoothness', ir.roughness, 'Smoothness', 'float', true], ['Emission', ir.emission, 'Emission', 'vec3']] as [string, Arg | null, string, SockType, boolean?][] : [])]
  const shown = outs.filter(([, a]) => a)
  if (ir.cutout && target === 'godot') shown.push(['Alpha Scissor Threshold', { k: 'lit', v: 0.5, type: 'float' }, 19, 'float'])
  const outTitle = { godot: 'Output', unreal: ir.name, unity: 'Fragment' }[target]
  const out = add({ id: 'out', title: outTitle, cls: 'Output', cat: 'output', sink: true, props: { ports: shown.map(([, , p]) => p) }, ins: shown.map(([nm, , , t]) => ({ n: nm, t })), outs: [], note: target === 'unreal' ? `${ir.lit ? 'Default Lit' : 'Unlit'}${ir.cutout ? ', Masked, Two Sided' : ir.alpha ? ', Translucent' : ''}` : target === 'unity' ? `${ir.lit ? 'Lit' : 'Unlit'} Shader Graph` : undefined })
  shown.forEach(([, a, , , clampIt], i) => {
    if (!a) return
    // Unity wants smoothness (1 - roughness); every program wants 0..1 for these
    if (target === 'unity' && out.ins[i].n === 'Smoothness') {
      const om = add({ title: 'One Minus', cls: 'OneMinusNode', cat: 'converter', props: {}, ins: [{ n: 'In', t: 'float' }], outs: [{ n: 'Out', t: 'float' }] })
      feed(a, om, 0); links.push({ a: om.id, ao: 0, b: out.id, bi: i }); return
    }
    if (clampIt && a.k === 'ref') {
      const sat = add({ title: names.saturate_f.title, cls: names.saturate_f.cls, cat: 'converter', props: { ...(names.saturate_f.props ?? {}) }, note: names.saturate_f.note, ins: [{ n: names.saturate_f.ins[0], t: 'float' }], outs: [{ n: names.saturate_f.out, t: 'float' }] })
      feed(a, sat, 0); links.push({ a: sat.id, ao: 0, b: out.id, bi: i }); return
    }
    feed(a, out, i)
  })
  // bump: a code node turns the height into a normal, as every target's bump does
  if (ir.lit && ir.bump) {
    const outNorm = target === 'godot' ? ['Normal', 8] : target === 'unreal' ? ['Normal', 'MP_NORMAL'] : ['Normal (World Space)', 'NormalWS']
    const ins: [string, SockType][] = target === 'godot' ? [['h', 'float']] : [['h', 'float'], ['pos', 'vec3'], ['nrm', 'vec3']]
    const code = target === 'godot' ? 'n = inoscula_bump(VERTEX, NORMAL, h);' : target === 'unreal' ? 'return inoscula_bump(pos, nrm, h * 100.0);' : 'n = inoscula_bump(pos, nrm, h);'
    const b = add({ title: codeTitle, cls: codeCls, cat: 'custom', props: { description: 'Bump' }, note: 'Bump (height to normal)', code, ports: { ins, outs: [['n', 'vec3']] }, ins: ins.map(([nm, t]) => ({ n: nm, t })), outs: [{ n: 'n', t: 'vec3' }] })
    feed(ir.bump, b, 0)
    if (target !== 'godot') {
      const P = add({ title: target === 'unreal' ? 'Absolute World Position' : 'Position', cls: target === 'unreal' ? 'MaterialExpressionWorldPosition' : 'PositionNode', cat: 'input', props: {}, note: target === 'unity' ? 'World' : undefined, ins: [], outs: [{ n: target === 'unreal' ? '' : 'Out', t: 'vec3' }] })
      const N = add({ title: target === 'unreal' ? 'VertexNormalWS' : 'Normal Vector', cls: target === 'unreal' ? 'MaterialExpressionVertexNormalWS' : 'NormalVectorNode', cat: 'input', props: {}, note: target === 'unity' ? 'World' : undefined, ins: [], outs: [{ n: target === 'unreal' ? '' : 'Out', t: 'vec3' }] })
      links.push({ a: P.id, ao: 0, b: b.id, bi: 1 }, { a: N.id, ao: 0, b: b.id, bi: 2 })
    }
    out.ins.push({ n: outNorm[0] as string, t: 'vec3' }); (out.props.ports as unknown[]).push(outNorm[1])
    links.push({ a: b.id, ao: 0, b: out.id, bi: out.ins.length - 1 })
  }
  return { nodes, links, target, out: out.id }
}

export function nativeView(ir: IR, target: Target): NodeView {
  const g = nativeGraph(ir, target)
  const legend = {
    godot: `Godot · VisualShader (Spatial, Fragment). These are the nodes in the .tres the Godot tab saves. Expression nodes run Blender's noise and Voronoi maths, from the Global Expression.`,
    unreal: `Unreal · Material Editor. Maths are native expressions; Custom nodes carry Blender's noise, Voronoi and colour ramps so the pattern matches.`,
    unity: `Unity · Shader Graph. The nodes to build it by hand. The Unity tab gives a ready Custom Function file for the same result.`,
  }[target]
  return { nodes: g.nodes, links: g.links, theme: target, legend }
}

// ------------------------------------------------------------------ Godot: write the VisualShader resource
const toSrgbN = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)
const ENUMS = new Set(['op_type', 'operator', 'function', 'hint', 'qualifier'])
const SKIP = new Set(['description', 'op', 'step', 'vec'])
const gv = (v: unknown, kind?: string): string => {
  if (typeof v === 'boolean') return String(v)
  if (typeof v === 'number') return kind === 'int' ? String(Math.round(v)) : num(v)
  if (Array.isArray(v)) return kind === 'color' ? `Color(${v.map((c) => num(+toSrgbN(c).toFixed(6))).join(', ')}, 1)` : `Vector3(${v.map(num).join(', ')})`
  return JSON.stringify(v)
}
const PORT = { float: 0, vec3: 4, color: 4, shader: 0 } as Record<SockType, number>
export function toGodotVisual(ir: IR): string {
  const g = nativeGraph(ir, 'godot')
  const gid = new Map<string, number>([['out', 0]])
  let next = 3
  for (const n of g.nodes) if (n.id !== 'out') gid.set(n.id, next++)
  // columns for the editor: each node right of whatever feeds it
  const col = new Map<string, number>(), feeds = new Map<string, string[]>()
  for (const l of g.links) (feeds.get(l.b) ?? feeds.set(l.b, []).get(l.b)!).push(l.a)
  const colOf = (id: string): number => col.get(id) ?? (col.set(id, 0), col.set(id, 1 + Math.max(-1, ...(feeds.get(id) ?? []).map(colOf))), col.get(id)!)
  g.nodes.forEach((n) => colOf(n.id))
  const rows = new Map<number, number>()
  const pos = (n: NNode) => { const c = col.get(n.id)!, r = rows.get(c) ?? 0; rows.set(c, r + 1); return `Vector2(${c * 300 - 1400}, ${r * 220 - 400})` }
  const subs: string[] = [], lines: string[] = []
  const helpersCode = helpers(ir, LANG.godot)
  subs.push(`[sub_resource type="VisualShaderNodeGlobalExpression" id="global"]\nexpression = ${JSON.stringify(`// ${ir.name}, made with Inoscula\n// inoscula-graph: ${JSON.stringify(ir.source)}\nvec3 inoscula_canon(vec3 p) { return vec3(p.x, -p.z, p.y); }\n${helpersCode}`)}`)
  lines.push(`nodes/fragment/2/node = SubResource("global")`, `nodes/fragment/2/position = Vector2(-1800, -900)`, `nodes/fragment/2/size = Vector2(600, 400)`, `nodes/fragment/2/input_ports = ""`, `nodes/fragment/2/output_ports = ""`)
  for (const n of g.nodes) {
    if (n.id === 'out') continue
    const id = gid.get(n.id)!
    const props = Object.entries(n.props).filter(([k]) => !SKIP.has(k)).map(([k, v]) => `${k} = ${gv(v, n.cls === 'VisualShaderNodeColorParameter' && k === 'default_value' ? 'color' : ENUMS.has(k) ? 'int' : undefined)}`)
    const defaults = n.ins.map((i, k) => (i.v !== undefined && !g.links.some((l) => l.b === n.id && l.bi === k) ? `${k}, ${typeof i.v === 'number' && i.t === 'vec3' ? gv([i.v, i.v, i.v]) : gv(i.v)}` : null)).filter(Boolean)
    if (defaults.length && n.cls !== 'VisualShaderNodeExpression') props.push(`default_input_values = [${defaults.join(', ')}]`)
    if (n.cls === 'VisualShaderNodeExpression') {
      // literal inputs of a code node go straight into its code
      let code = n.code!
      n.ins.forEach((i, k) => { if (i.v !== undefined && !g.links.some((l) => l.b === n.id && l.bi === k)) code = `${i.t === 'float' ? 'float' : 'vec3'} ${i.n}_k = ${i.t === 'float' ? num(i.v as number) : Array.isArray(i.v) ? `vec3(${(i.v as number[]).map(num).join(', ')})` : `vec3(${num(i.v as number)})`};\n` + code.replace(new RegExp(`\\b${i.n}\\b`, 'g'), `${i.n}_k`) })
      const inPorts = n.ports!.ins.map(([nm, t], k) => `${k},${PORT[t]},${nm};`).join('')
      const outPorts = n.ports!.outs.map(([nm, t], k) => `${k},${PORT[t]},${nm};`).join('')
      subs.push(`[sub_resource type="VisualShaderNodeExpression" id="n${id}"]\nsize = Vector2(320, ${120 + 22 * Math.max(n.ports!.ins.length, n.ports!.outs.length)})\nexpression = ${JSON.stringify(code)}`)
      lines.push(`nodes/fragment/${id}/node = SubResource("n${id}")`, `nodes/fragment/${id}/position = ${pos(n)}`, `nodes/fragment/${id}/size = Vector2(320, ${120 + 22 * Math.max(n.ports!.ins.length, n.ports!.outs.length)})`, `nodes/fragment/${id}/input_ports = "${inPorts}"`, `nodes/fragment/${id}/output_ports = "${outPorts}"`, `nodes/fragment/${id}/expression = ${JSON.stringify(code)}`)
      continue
    }
    subs.push(`[sub_resource type="${n.cls}" id="n${id}"]${props.length ? '\n' + props.join('\n') : ''}`)
    lines.push(`nodes/fragment/${id}/node = SubResource("n${id}")`, `nodes/fragment/${id}/position = ${pos(n)}`)
  }
  const outNode = g.nodes.find((n) => n.id === 'out')!
  const ports = outNode.props.ports as number[]
  const conns: number[] = []
  for (const l of g.links) conns.push(gid.get(l.a)!, l.ao, gid.get(l.b)!, l.b === 'out' ? ports[l.bi] : l.bi)
  // fixed values straight into the output (no node needed): a constant node per value
  outNode.ins.forEach((i, k) => {
    if (i.v === undefined || g.links.some((l) => l.b === 'out' && l.bi === k)) return
    const id = next++
    const v = i.t === 'float' ? `constant = ${num(i.v as number)}` : `constant = ${gv(Array.isArray(i.v) ? i.v : [i.v, i.v, i.v])}`
    subs.push(`[sub_resource type="${i.t === 'float' ? 'VisualShaderNodeFloatConstant' : 'VisualShaderNodeVec3Constant'}" id="n${id}"]\n${v}`)
    lines.push(`nodes/fragment/${id}/node = SubResource("n${id}")`, `nodes/fragment/${id}/position = Vector2(${(Math.max(...col.values()) - 1) * 300 - 1400}, ${600 + k * 120})`)
    conns.push(id, 0, 0, ports[k])
  })
  const modes = [ir.cutout ? 'modes/cull = 2' : '', !ir.lit ? 'flags/unshaded = true' : ''].filter(Boolean)
  return `[gd_resource type="VisualShader" load_steps=${subs.length + 1} format=3]

${subs.join('\n\n')}

[resource]
${modes.join('\n')}${modes.length ? '\n' : ''}nodes/fragment/0/position = Vector2(${Math.max(...col.values()) * 300 - 1300}, 0)
${lines.join('\n')}
nodes/fragment/connections = PackedInt32Array(${conns.join(', ')})
`
}

// ------------------------------------------------------------------ Unreal: build the same graph from material expressions
// literal inputs of a code node go into its code, so the node needs no extra constant nodes
function inlineLiterals(n: NNode, links: GLink[], code: string, L: Lang) {
  n.ins.forEach((i, k) => {
    if (i.v === undefined || links.some((l) => l.b === n.id && l.bi === k)) return
    const val = i.t === 'float' ? num(i.v as number) : Array.isArray(i.v) ? L.v3(...((i.v as number[]).map(num) as [string, string, string])) : L.splat(num(i.v as number))
    code = `${L.ty(i.t === 'float' ? 'float' : 'vec3')} ${i.n}_k = ${val};\n` + code.replace(new RegExp(`\\b${i.n}\\b`, 'g'), `${i.n}_k`)
  })
  return code
}
export function toUnrealNative(ir: IR, o: { folder?: string } = {}): string {
  const g = nativeGraph(ir, 'unreal')
  const H = helperParts(LANG.hlsl)
  const py = (s: string) => JSON.stringify(s)
  const name = 'M_' + ir.name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')
  const col = new Map<string, number>(), feeds = new Map<string, string[]>()
  for (const l of g.links) (feeds.get(l.b) ?? feeds.set(l.b, []).get(l.b)!).push(l.a)
  const colOf = (id: string): number => col.get(id) ?? (col.set(id, 0), col.set(id, 1 + Math.max(-1, ...(feeds.get(id) ?? []).map(colOf))), col.get(id)!)
  g.nodes.forEach((n) => colOf(n.id))
  const maxC = Math.max(...col.values()), rows = new Map<number, number>()
  const xy = (n: NNode) => { const c = col.get(n.id)!, r = rows.get(c) ?? 0; rows.set(c, r + 1); return `${(c - maxC) * 320 - 300}, ${r * 180 - 300}` }
  const lc = (v: number[]) => `unreal.LinearColor(${v.map(num).join(', ')}, 1.0)`
  const out: string[] = []
  let k = 0
  const constNode = (v: unknown) => {
    const id = 'k' + k++
    if (Array.isArray(v)) out.push(`${id} = add(unreal.MaterialExpressionConstant3Vector, -2400, ${k * 60})`, `${id}.set_editor_property("constant", ${lc(v as number[])})`)
    else out.push(`${id} = add(unreal.MaterialExpressionConstant, -2400, ${k * 60})`, `${id}.set_editor_property("r", ${num(v as number)})`)
    return id
  }
  // the scalar defaults each expression keeps for an input with nothing wired to it
  const CONST: Record<string, string[]> = {
    MaterialExpressionAdd: ['const_a', 'const_b'], MaterialExpressionSubtract: ['const_a', 'const_b'], MaterialExpressionMultiply: ['const_a', 'const_b'],
    MaterialExpressionDivide: ['const_a', 'const_b'], MaterialExpressionMin: ['const_a', 'const_b'], MaterialExpressionMax: ['const_a', 'const_b'],
    MaterialExpressionLinearInterpolate: ['const_a', 'const_b', 'const_alpha'], MaterialExpressionClamp: ['', 'min_default', 'max_default'],
    MaterialExpressionSmoothStep: ['const_min', 'const_max', 'const_value'],
  }
  for (const n of g.nodes) {
    if (n.id === 'out') continue
    out.push(`${n.id} = add(unreal.${n.cls}, ${xy(n)})`)
    for (const [key, v] of Object.entries(n.props)) {
      if (SKIP.has(key)) continue
      if (key === 'default_value') out.push(`${n.id}.set_editor_property("default_value", ${Array.isArray(v) ? lc(v as number[]) : num(v as number)})`)
      else if (key === 'constant') out.push(`${n.id}.set_editor_property("constant", ${lc(v as number[])})`)
      else out.push(`${n.id}.set_editor_property(${py(key)}, ${typeof v === 'boolean' ? (v ? 'True' : 'False') : typeof v === 'number' ? num(v) : py(String(v))})`)
    }
    if (n.cls === 'MaterialExpressionCustom') {
      const op = n.props.op as string | undefined
      let code: string
      if (op === 'voronoi') code = 'float d; float3 c; float3 q;\nf.inoscula_voronoi(p, scale, randomness, d, c, q);\ncolor = c;\nposition = q;\nreturn d;'
      else if (n.ports!.outs.length === 1 && /^\w+ = /.test(n.code!)) code = n.code!.replace(/^\w+ = /, 'return ')
      else code = n.code!
      code = inlineLiterals(n, g.links, code, LANG.hlsl).replace(/\bvec3\(/g, 'float3(').replace(/(?<!\.)\binoscula_(?!\w+_k\b)/g, 'f.inoscula_')
      const need = [H.base]
      if (op === 'noise' || op === 'white_noise') need.push(H.hash)
      if (op === 'noise') need.push(H.noise)
      if (op === 'voronoi') need.push(H.voronoi)
      if (op === 'ramp') need.push(H.ramp(ir.steps.find((s) => s.id === n.props.step)!))
      if (/inoscula_bump/.test(code)) need.push(H.bump)
      if (/f\.inoscula_/.test(code)) code = `struct F {\n${need.join('\n')}\n};\nF f;\n${code}`
      const ot = (t: SockType) => (t === 'float' ? 'CMOT_FLOAT1' : 'CMOT_FLOAT3')
      out.push(`${n.id}.set_editor_property("code", ${py(code)})`)
      out.push(`${n.id}.set_editor_property("output_type", unreal.CustomMaterialOutputType.${ot(n.ports!.outs[0][1])})`)
      out.push(`${n.id}.set_editor_property("inputs", [${n.ports!.ins.map(([nm]) => `unreal.CustomInput(input_name=${py(nm)})`).join(', ')}])`)
      if (n.ports!.outs.length > 1) out.push(`${n.id}.set_editor_property("additional_outputs", [${n.ports!.outs.slice(1).map(([nm, t]) => `unreal.CustomOutput(output_name=${py(nm)}, output_type=unreal.CustomMaterialOutputType.${ot(t)})`).join(', ')}])`)
      continue
    }
    // literal inputs: the expression's own default where it has one, a constant node otherwise
    n.ins.forEach((i, idx) => {
      if (i.v === undefined || g.links.some((l) => l.b === n.id && l.bi === idx)) return
      const prop = CONST[n.cls]?.[idx]
      if (prop && typeof i.v === 'number') out.push(`${n.id}.set_editor_property(${py(prop)}, ${num(i.v)})`)
      else out.push(`L.connect_material_expressions(${constNode(i.v)}, "", ${n.id}, ${py(i.n)})`)
    })
  }
  const outNode = g.nodes.find((n) => n.id === 'out')!
  const props = outNode.props.ports as string[]
  for (const l of g.links) {
    const A = g.nodes.find((n) => n.id === l.a)!, B = g.nodes.find((n) => n.id === l.b)!
    const from = A.cls === 'MaterialExpressionCustom' && l.ao > 0 ? A.outs[l.ao].n : A.cls === 'MaterialExpressionVectorParameter' ? 'RGB' : ''
    if (l.b === 'out') out.push(`L.connect_material_property(${l.a}, ${py(from)}, unreal.MaterialProperty.${props[l.bi]})`)
    else out.push(`L.connect_material_expressions(${l.a}, ${py(from)}, ${l.b}, ${py(B.ins[l.bi].n)})`)
  }
  outNode.ins.forEach((i, idx) => {
    if (i.v === undefined || g.links.some((l) => l.b === 'out' && l.bi === idx)) return
    out.push(`L.connect_material_property(${constNode(i.v)}, "", unreal.MaterialProperty.${props[idx]})`)
  })
  const full = toUnreal(ir, { folder: o.folder })
  const outline = full.includes('# ---- outline:') ? full.slice(full.indexOf('\n# ---- outline:')) : ''
  return `# ${ir.name}, made with Inoscula. Native material expressions: every maths node is Unreal's own.
# Run inside the Unreal Editor: Tools > Execute Python Script (needs the Python Editor Script Plugin).
# Builds ${o.folder ?? '/Game/Inoscula'}/${name}. Parameters are Scalar and Vector Parameters, so a Material Instance and
# Sequencer can animate them. Custom nodes carry Blender's noise and Voronoi maths, so patterns match the other tools.
import unreal

FOLDER = ${py(o.folder ?? '/Game/Inoscula')}
NAME = ${py(name)}
L = unreal.MaterialEditingLibrary
tools = unreal.AssetToolsHelpers.get_asset_tools()
path = FOLDER + "/" + NAME
if unreal.EditorAssetLibrary.does_asset_exist(path):
    mat = unreal.EditorAssetLibrary.load_asset(path)
    L.delete_all_material_expressions(mat)
else:
    mat = tools.create_asset(NAME, FOLDER, unreal.Material, unreal.MaterialFactoryNew())
mat.set_editor_property("shading_model", unreal.MaterialShadingModel.${ir.lit ? 'MSM_DEFAULT_LIT' : 'MSM_UNLIT'})
mat.set_editor_property("blend_mode", unreal.BlendMode.${ir.cutout ? 'BLEND_MASKED' : ir.alpha ? 'BLEND_TRANSLUCENT' : 'BLEND_OPAQUE'})${ir.cutout ? '\nmat.set_editor_property("two_sided", True)' : ''}${ir.lit && ir.bump ? '\nmat.set_editor_property("tangent_space_normal", False)  # the bump node gives a world space normal' : ''}

def add(cls, x, y):
    return L.create_material_expression(mat, cls, x, y)

${out.join('\n')}

L.layout_material_expressions(mat)
L.recompile_material(mat)
# keep the Inoscula graph on the asset, so it can travel back out with any changes
unreal.EditorAssetLibrary.set_metadata_tag(mat, "inoscula", ${py(JSON.stringify(ir.source))})
unreal.EditorAssetLibrary.save_asset(path)
print("Inoscula: built " + path)
${outline}`
}
