# Outer rim and offset outlines for Blender: adds three copies of the selected mesh, inflated along its smooth
# normals (so sharp edges stay closed), the two outlines also shifted a little at random. Their normals point
# inwards and their UVs say which is which (u = 200.5 rim, 201.5 and 202.5 outlines), so an Inoscula look made for
# them (Wet Stroke) draws them with the same material, as Inoscula Studio does (src/cards.ts paintShells).
# Run it from the Text Editor with your model selected.
import bpy, bmesh, json, random
from mathutils import Vector

RIM, OUTLINE, OFFSET, SEED = 0.025, 0.05, 0.025, 11

ob = bpy.context.active_object
if ob is None or ob.type != "MESH":
    raise SystemExit("Select a mesh first.")
mat = ob.active_material
if mat is not None and "inoscula_shells" in mat:
    RIM, OUTLINE, OFFSET = json.loads(mat["inoscula_shells"])

me = ob.data
size = Vector(ob.dimensions).length / max(max(ob.scale), 1e-6) or 1.0
# smooth normals: the average normal of every vertex at the same position
acc = {}
for v in me.vertices:
    k = tuple(round(c, 4) for c in v.co)
    acc[k] = acc.get(k, Vector()) + v.normal
rng = random.Random(SEED)
shells = [(RIM, 0, Vector())]
for k in (1, 2):
    off = Vector((rng.random() - 0.5, rng.random() - 0.5, rng.random() - 0.5)).normalized() * OFFSET * size
    shells.append((OUTLINE * (0.8 + 0.4 * rng.random()), k, off))

old = bpy.data.objects.get(ob.name + " Shells")
if old is not None:
    bpy.data.objects.remove(old)
bm = bmesh.new()
uvl = bm.loops.layers.uv.new("UVMap")
col = bm.verts.layers.float_color.new("Col")
for inflate, kind, off in shells:
    vmap = []
    for v in me.vertices:
        s = acc[tuple(round(c, 4) for c in v.co)].normalized()
        nv = bm.verts.new(v.co + s * inflate * size + off)
        nv[col] = (0.5, 1.0, 0.5, 1.0)
        vmap.append(nv)
    for p in me.polygons:
        f = bm.faces.new([vmap[i] for i in reversed(p.vertices)])  # reversed: normals point inwards
        f.smooth = True
        for l in f.loops:
            l[uvl].uv = (200.5 + kind, 0.5)
nm = bpy.data.meshes.new(ob.name + " Shells")
bm.to_mesh(nm)
bm.free()
if mat is not None:
    nm.materials.append(mat)
sh = bpy.data.objects.new(ob.name + " Shells", nm)
for c in ob.users_collection:
    c.objects.link(sh)
sh.parent = ob
sh["inoscula_object_size"] = ob.get("inoscula_object_size", Vector(ob.dimensions).length)
print("Inoscula: rim and outlines on " + ob.name)
