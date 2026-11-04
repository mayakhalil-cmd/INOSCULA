# Render check, Blender side: the Inoscula test scene (sphere and knot on a floor, a sun, a soft sky), rendered with
# the material the Inoscula Blender script builds.
#   blender --background --python render_blender.py -- <shader.blender.py> <out.png> [CYCLES|EEVEE] [samples]
#   or, with the bpy module: python3 render_blender.py <shader.blender.py> <out.png> ...
import sys, math, bpy, bmesh
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
script, out = argv[0], argv[1]
engine = (argv[2] if len(argv) > 2 else "CYCLES").upper()
samples = int(argv[3]) if len(argv) > 3 else 64

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.resolution_x, sc.render.resolution_y = 640, 480
if engine.startswith("EEVEE"):
    sc.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items.keys() else "BLENDER_EEVEE"
else:
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
sc.view_settings.view_transform = "AgX"
sc.frame_set(0)

# sun (towards the light: normalize(-0.5, -0.6, 0.62)), named so Inoscula's light bridge follows it
sun_data = bpy.data.lights.new("RICO Sun", "SUN")
sun_data.energy = 3.5
sun_data.angle = math.radians(3)
sun = bpy.data.objects.new("RICO Sun", sun_data)
sc.collection.objects.link(sun)
d = (-0.5, -0.6, 0.62)
from mathutils import Vector
sun.rotation_mode = "QUATERNION"
sun.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(Vector(d).normalized())

# soft sky
w = bpy.data.worlds.new("Sky")
sc.world = w
nt = w.node_tree
bg = nt.nodes["Background"] if "Background" in nt.nodes else nt.nodes.new("ShaderNodeBackground")
bg.inputs["Color"].default_value = (0.35, 0.42, 0.55, 1.0)
bg.inputs["Strength"].default_value = 0.6

def obj(name, me):
    o = bpy.data.objects.new(name, me)
    sc.collection.objects.link(o)
    return o
me = bpy.data.meshes.new("Ball")
bm = bmesh.new(); bm.loops.layers.uv.new("UVMap")
bmesh.ops.create_uvsphere(bm, u_segments=96, v_segments=48, radius=1.0, calc_uvs=True)
bm.to_mesh(me); bm.free()
for p in me.polygons: p.use_smooth = True
ball = obj("Ball", me); ball.location = (-1.15, 0, 1.0)
bpy.ops.mesh.primitive_cube_add(size=1.5, location=(1.15, 0, 0.75), rotation=(0, 0, math.radians(30)))
torus = bpy.context.active_object
# flat faces, like the boxes in Godot and three.js, so every renderer sees the same geometry
bpy.ops.object.shade_flat()
floor_me = bpy.data.meshes.new("Floor")
bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=20); bm.to_mesh(floor_me); bm.free()
floor = obj("Floor", floor_me)
fm = bpy.data.materials.new("Floor")
fm.diffuse_color = (0.5, 0.5, 0.5, 1)
fm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.32, 0.32, 0.32, 1)
fm.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9
floor.data.materials.append(fm)

ns = {"__name__": "__inoscula__"}
exec(compile(open(script).read(), script, "exec"), ns)
mat = bpy.data.materials[ns["MAT"]]
for o in (ball, torus):
    o.data.materials.clear(); o.data.materials.append(mat)
# run the Inoscula script again now the objects use the material, so per-object parts (the outline) attach
exec(compile(open(script).read(), script, "exec"), {"__name__": "__inoscula__"})
# looks made for a rim and offset outlines: add them, as importers/inoscula_shells_blender.py does
if "inoscula_shells" in mat:
    import os
    sh_py = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "importers", "inoscula_shells_blender.py")
    for o in (ball, torus):
        bpy.context.view_layer.objects.active = o
        exec(compile(open(sh_py).read(), sh_py, "exec"), {"__name__": "__inoscula__"})
# looks made for brush cards: lay the cards, as importers/inoscula_cards_blender.py does
if "inoscula_cards" in mat:
    import os
    cards_py = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "importers", "inoscula_cards_blender.py")
    for o in (ball, torus):
        bpy.context.view_layer.objects.active = o
        exec(compile(open(cards_py).read(), cards_py, "exec"), {"__name__": "__inoscula__"})

cam_data = bpy.data.cameras.new("Cam"); cam_data.lens = 50
cam = obj("Cam", cam_data)
cam.location = (0, -6.2, 1.6)
cam.rotation_mode = "XYZ"
direction = Vector((0, 0, 0.9)) - cam.location
cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
sc.camera = cam
sc.render.filepath = out
bpy.ops.render.render(write_still=True)
print("Inoscula: rendered", out)
