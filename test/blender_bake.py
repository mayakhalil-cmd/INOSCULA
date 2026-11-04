# Parity test, Blender side. For each Blender script Inoscula made: build a sphere, run the script, assign the
# material, bake its emission into a float image with Cycles (CPU), and save the pixels plus the exact mesh so
# the other engines can draw the very same surface.
#   python3 blender_bake.py <out_dir> <shader.blender.py> [...]
import sys, json, base64, array, math
import bpy, bmesh

out_dir = sys.argv[1]
scripts = sys.argv[2:]
SIZE = 256

def fresh():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = 1
    sc.cycles.use_denoising = False
    sc.cycles.filter_width = 0.01  # sample texel centres, no pixel filter jitter
    sc.frame_set(0)
    me = bpy.data.meshes.new("Ball")
    bm = bmesh.new()
    bm.loops.layers.uv.new("UVMap")
    bmesh.ops.create_uvsphere(bm, u_segments=48, v_segments=24, radius=1.0, calc_uvs=True)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new("Ball", me)
    sc.collection.objects.link(ob)
    ob.location = (0.3, -0.2, 0.1)
    ob.rotation_euler = (0.4, 0.2, 0.7)
    ob.scale = (1.0, 1.0, 1.0)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.context.view_layer.update()
    return sc, ob, me

def mesh_data(ob, me):
    me.calc_loop_triangles()
    uvl = me.uv_layers.active.data
    cn = me.corner_normals if hasattr(me, "corner_normals") else None
    pos, nrm, uv = [], [], []
    for tri in me.loop_triangles:
        for li, vi in zip(tri.loops, tri.vertices):
            pos += list(me.vertices[vi].co)
            nrm += list(cn[li].vector) if cn is not None else list(me.loops[li].normal)
            uv += list(uvl[li].uv)
    return {"pos": pos, "nrm": nrm, "uv": uv, "matrix": [list(r) for r in ob.matrix_world]}

def bake_inputs(ob):
    """Bakes what Blender itself sees at each texel (positions, normals, UVs), so the other side can run the
    shader on exactly the same numbers. This separates the maths from where each renderer samples."""
    out = {}
    m = bpy.data.materials.new("inputs")
    nt = m.node_tree
    nt.nodes.clear()
    tc = nt.nodes.new("ShaderNodeTexCoord")
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    em = nt.nodes.new("ShaderNodeEmission")
    o = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(em.outputs[0], o.inputs["Surface"])
    img = bpy.data.images.new("inbake", SIZE, SIZE, alpha=True, float_buffer=True)
    img.colorspace_settings.name = "Non-Color"
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    nt.nodes.active = tex
    old = list(ob.data.materials)
    ob.data.materials.clear()
    ob.data.materials.append(m)
    for key, sock in (("uv", tc.outputs["UV"]), ("object_pos", tc.outputs["Object"]), ("object_normal", tc.outputs["Normal"]),
                      ("world_pos", geo.outputs["Position"]), ("normal", geo.outputs["Normal"])):
        nt.links.new(sock, em.inputs["Color"])
        img.pixels.foreach_set(array.array("f", [0.0] * (SIZE * SIZE * 4)))
        bpy.ops.object.bake(type="EMIT", margin=0, use_clear=False)
        px = array.array("f", [0.0] * (SIZE * SIZE * 4))
        img.pixels.foreach_get(px)
        out[key] = base64.b64encode(px.tobytes()).decode()
    ob.data.materials.clear()
    for mm in old:
        ob.data.materials.append(mm)
    return out

results = {}
for path in scripts:
    sc, ob, me = fresh()
    ns = {"__name__": "__inoscula__"}
    exec(compile(open(path).read(), path, "exec"), ns)
    mat = bpy.data.materials[ns["MAT"]]
    # an outline adds a shell and a second material: the bake compares the surface itself
    for mod in list(ob.modifiers):
        ob.modifiers.remove(mod)
    ob.data.materials.clear()
    ob.data.materials.append(mat)
    ob["inoscula_object_size"] = 2.0  # the size the other side assumes (Inoscula's default)
    img = bpy.data.images.new("bake", SIZE, SIZE, alpha=True, float_buffer=True)
    img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(array.array("f", [0.0, 0.0, 0.0, 0.0] * SIZE * SIZE))
    tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = img
    mat.node_tree.nodes.active = tex
    bpy.ops.object.bake(type="EMIT", margin=0, use_clear=False)
    px = array.array("f", [0.0] * (SIZE * SIZE * 4))
    img.pixels.foreach_get(px)
    name = ns["MAT"]
    results[name] = {"pixels": base64.b64encode(px.tobytes()).decode(), "size": SIZE, "mesh": mesh_data(ob, me),
                     "inputs": bake_inputs(ob)}
    print("baked", name)

with open(out_dir + "/blender.json", "w") as f:
    json.dump(results, f)
