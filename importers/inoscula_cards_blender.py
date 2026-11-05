# Brush cards for Blender: lays single brush strokes over the selected mesh, lifted just off the surface so they
# overlap and break the silhouette, the same way Inoscula Studio does (src/cards.ts). Run it from the Text Editor
# with your model selected. It makes "<model> Brush Cards", parented to the model, with the model's first
# material on it, so an Inoscula look made for cards (Oil Strokes) draws a stroke on each card.
#
# Change the numbers below, or set them from an Inoscula look: a look with "cards 3500, 0.06, 0.34;" stores them
# in its graph, and the Blender export of that look keeps them on the material as "inoscula_cards".
import bpy, bmesh, json, math, random
from mathutils import Vector

COUNT = 3500    # number of strokes
LENGTH = 0.06   # stroke length, as a fraction of the model's size
WIDTH = 0.34    # stroke width, as a fraction of its length
LIFT = 0.12     # how far strokes float off the surface, as a fraction of their width
SCATTER = 0.35  # 0: strokes wrap around the form, 1: every stroke points its own way
SEED = 7
CARD_U = 100    # u of the first card; must match the shader

ob = bpy.context.active_object
if ob is None or ob.type != "MESH":
    raise SystemExit("Select a mesh first.")
mat = ob.active_material
if mat is not None and "inoscula_cards" in mat:
    vals = json.loads(mat["inoscula_cards"])
    COUNT, LENGTH, WIDTH = vals[:3]
    if len(vals) > 3:
        LIFT = vals[3]

dg = bpy.context.evaluated_depsgraph_get()
src = ob.evaluated_get(dg).to_mesh()
bm = bmesh.new()
bm.from_mesh(src)
bmesh.ops.triangulate(bm, faces=bm.faces[:])
bm.verts.ensure_lookup_table()
tris = [f for f in bm.faces]
pts = [v.co.copy() for v in bm.verts]
lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
size = (hi - lo).length or 1.0
center = (lo + hi) * 0.5
areas, total = [], 0.0
for f in tris:
    total += f.calc_area()
    areas.append(total)

rng = random.Random(SEED)
L0, W0 = LENGTH * size, LENGTH * size * WIDTH
lift0 = W0 * LIFT
SEG = 4
up = Vector((0, 0, 1))
verts, faces, uvs, normals = [], [], [], []
import bisect
for c in range(COUNT):
    f = tris[min(bisect.bisect_left(areas, rng.random() * total), len(tris) - 1)]
    u, v = rng.random(), rng.random()
    if u + v > 1:
        u, v = 1 - u, 1 - v
    a, b, cc = f.verts
    p = a.co * (1 - u - v) + b.co * u + cc.co * v
    n = (a.normal * (1 - u - v) + b.normal * u + cc.normal * v).normalized() if f.smooth else f.normal.copy()
    around = up.cross(n)
    if around.length_squared < 1e-4:
        around = Vector((1, 0, 0)).cross(n)
    around.normalize()
    side = n.cross(around)
    ang = (rng.random() - 0.5) * (0.6 + SCATTER * 2.6)
    d = (around * math.cos(ang) + side * math.sin(ang)).normalized()
    acr = n.cross(d)
    radius = max((p - center).length, L0 * 0.5)
    L, W, lift = L0 * (0.7 + rng.random() * 0.6), W0 * (0.75 + rng.random() * 0.5), lift0 * (0.5 + rng.random())
    cid = math.floor(rng.random() * 64)
    base = len(verts)
    for s in range(SEG + 1):
        t = s / SEG - 0.5
        along = t * L
        mid = p + d * along + n * (lift - along * along / (2 * radius))
        for k in (-0.5, 0.5):
            verts.append(mid + acr * (k * W))
            uvs.append((CARD_U + cid + s / SEG, k + 0.5))
    for s in range(SEG):
        i = base + s * 2
        faces.append((i, i + 2, i + 3, i + 1))  # facing out
        normals.extend([n] * 4)
bm.free()
ob.evaluated_get(dg).to_mesh_clear()

me = bpy.data.meshes.new(ob.name + " Brush Cards")
me.from_pydata([tuple(v) for v in verts], [], faces)
uvl = me.uv_layers.new(name="UVMap")
for poly in me.polygons:
    for li in poly.loop_indices:
        uvl.data[li].uv = uvs[me.loops[li].vertex_index]
me.normals_split_custom_set([tuple(x) for x in normals])  # each stroke lit as one flat plane
col = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")  # neutral shape data: open, not on an edge
for i in range(len(me.vertices)):
    col.data[i].color = (0.5, 1.0, 0.5, 1.0)
if mat is not None:
    me.materials.append(mat)
old = bpy.data.objects.get(ob.name + " Brush Cards")
if old is not None:
    bpy.data.objects.remove(old)
cards = bpy.data.objects.new(ob.name + " Brush Cards", me)
for coll in ob.users_collection:
    coll.objects.link(cards)
cards.parent = ob
print(f"Inoscula: {COUNT} brush cards on {ob.name}")
