# A material built by hand in plain Blender nodes, not by Inoscula: noise on object coordinates, a constant colour
# ramp, light-facing bands from the Geometry normal, mixed with RGB nodes into an Emission. Used by the tests to
# prove Blender -> Inoscula -> other engines.
import bpy

def build():
    m = bpy.data.materials.new("Artist Made")
    nt = m.node_tree
    nt.nodes.clear()
    N = lambda t: nt.nodes.new(t)
    tc = N("ShaderNodeTexCoord")
    noise = N("ShaderNodeTexNoise"); noise.noise_dimensions = "3D"
    noise.inputs["Scale"].default_value = 4.0; noise.inputs["Detail"].default_value = 3.0
    nt.links.new(tc.outputs["Object"], noise.inputs["Vector"])
    ramp = N("ShaderNodeValToRGB"); ramp.color_ramp.interpolation = "CONSTANT"
    ramp.color_ramp.elements[0].color = (0.05, 0.05, 0.1, 1); ramp.color_ramp.elements[1].position = 0.5
    e = ramp.color_ramp.elements.new(0.62); e.color = (0.9, 0.85, 0.7, 1)
    ramp.color_ramp.elements[1].color = (0.4, 0.3, 0.5, 1)
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    geo = N("ShaderNodeNewGeometry")
    sep = N("ShaderNodeSeparateXYZ"); nt.links.new(geo.outputs["Normal"], sep.inputs[0])
    mr = N("ShaderNodeMapRange"); mr.interpolation_type = "SMOOTHSTEP"
    mr.inputs["From Min"].default_value = -0.2; mr.inputs["From Max"].default_value = 0.3
    nt.links.new(sep.outputs["Z"], mr.inputs["Value"])
    tint = N("ShaderNodeRGB"); tint.label = "Sky Tint"; tint.outputs[0].default_value = (0.3, 0.6, 1.0, 1)
    mix = N("ShaderNodeMix"); mix.data_type = "RGBA"
    nt.links.new(mr.outputs["Result"], mix.inputs["Factor"])
    nt.links.new(ramp.outputs["Color"], mix.inputs[6])
    nt.links.new(tint.outputs[0], mix.inputs[7])
    vm = N("ShaderNodeVectorMath"); vm.operation = "SCALE"
    amt = N("ShaderNodeValue"); amt.label = "Brightness"; amt.outputs[0].default_value = 1.2
    nt.links.new(mix.outputs[2], vm.inputs[0]); nt.links.new(amt.outputs[0], vm.inputs["Scale"])
    em = N("ShaderNodeEmission"); nt.links.new(vm.outputs[0], em.inputs["Color"])
    out = N("ShaderNodeOutputMaterial"); nt.links.new(em.outputs[0], out.inputs["Surface"])
    return m

MAT = "Artist Made"
build()
