# Round trip, Blender side: (1) every Inoscula-made Blender material is read back into a Inoscula graph, and
# (2) a material built by hand, the way an artist would, is imported and baked for comparison.
#   python3 blender_roundtrip.py <out_dir> <shader.blender.py> [...]
import sys, os, json, runpy
here = os.path.dirname(os.path.abspath(__file__))
imp = runpy.run_path(os.path.join(here, "..", "importers", "blender_to_inoscula.py"), run_name="inoscula_import")
import bpy

out_dir = sys.argv[1]
os.makedirs(out_dir + "/graphs", exist_ok=True)
for path in sys.argv[2:]:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ns = {"__name__": "__inoscula__"}
    exec(compile(open(path).read(), path, "exec"), ns)
    g, problems = imp["material_to_inoscula"](bpy.data.materials[ns["MAT"]])
    json.dump(g, open(out_dir + "/graphs/" + ns["MAT"].replace(" ", "_") + ".inoscula.json", "w"), indent=1)
    print("imported", ns["MAT"], len(g["nodes"]), "nodes", len(g["params"]), "params", problems)
