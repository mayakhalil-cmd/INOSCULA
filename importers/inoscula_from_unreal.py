# Unreal -> Inoscula. Select Inoscula materials, Material Instances or Material Functions in the Content Browser and
# run this (Tools > Execute Python Script). For each one it reads the Inoscula graph stored on the asset, takes
# the parameter values you set in Unreal (on the instance, or the material's own defaults), and writes
# <Project>/Saved/Inoscula/<name>.inoscula.json. Open that in Inoscula Studio or send it straight on to Blender or Godot.
#
# What travels back: every parameter value. Changes you make inside the Custom node's code, or nodes you add
# around it, stay in Unreal; make structural changes in Inoscula code or in Blender, which read back fully.
import json, os
import unreal

L = unreal.MaterialEditingLibrary
out_dir = os.path.join(unreal.Paths.project_saved_dir(), "Inoscula")
os.makedirs(out_dir, exist_ok=True)


def graph_of(asset):
    """The stored graph, looking through Material Instances to the material they come from."""
    a = asset
    while a is not None:
        tag = unreal.EditorAssetLibrary.get_metadata_tag(a, "inoscula")
        if tag:
            return json.loads(tag), a
        a = a.get_editor_property("parent") if isinstance(a, unreal.MaterialInstance) else None
    return None, None


def read_value(asset, prm):
    name = prm.get("label", prm["id"])
    vec = prm["type"] != "float"
    try:
        if isinstance(asset, unreal.MaterialInstance):
            if vec:
                c = L.get_material_instance_vector_parameter_value(asset, name)
                return [c.r, c.g, c.b]
            return L.get_material_instance_scalar_parameter_value(asset, name)
        if isinstance(asset, unreal.Material):
            if vec:
                c = L.get_material_default_vector_parameter_value(asset, name)
                return [c.r, c.g, c.b]
            return L.get_material_default_scalar_parameter_value(asset, name)
    except Exception as e:
        unreal.log_warning("Inoscula: could not read %s: %s" % (name, e))
    return prm["default"]


for asset in unreal.EditorUtilityLibrary.get_selected_assets():
    graph, owner = graph_of(asset)
    if graph is None:
        unreal.log_warning("Inoscula: %s has no Inoscula graph stored on it." % asset.get_name())
        continue
    for prm in graph.get("params", []):
        prm["default"] = read_value(asset, prm)
    path = os.path.join(out_dir, asset.get_name() + ".inoscula.json")
    with open(path, "w") as f:
        json.dump(graph, f, indent=2)
    print("Inoscula: wrote " + path)
