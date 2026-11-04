# Blender -> Inoscula. Reads a material's shader nodes (and any node groups inside it) and writes a Inoscula graph,
# which Inoscula then rebuilds natively for Godot, Unreal, Unity, three.js and RICO Engine.
#
# In Blender: open this in the Text Editor, select an object, Run Script. The graph is copied to the clipboard
# and saved next to the .blend file as <material>.inoscula.json.
# From a terminal:  blender scene.blend --background --python blender_to_inoscula.py -- "Material Name" out.inoscula.json
#
# Value and RGB nodes, and unconnected node group inputs, become editable parameters (named by their label).
# Anything Inoscula cannot reproduce exactly is listed by name, never silently dropped.
import bpy, json, sys, os

MATH = {"ADD": "add", "SUBTRACT": "sub", "MULTIPLY": "mul", "DIVIDE": "div", "POWER": "pow", "MINIMUM": "min",
        "MAXIMUM": "max", "ABSOLUTE": "abs", "FLOOR": "floor", "FRACT": "fract", "SINE": "sin", "COSINE": "cos",
        "GREATER_THAN": "greater", "EXPONENT": "exp", "SQRT": "sqrt"}
VMATH = {"ADD": "add", "SUBTRACT": "sub", "MULTIPLY": "mul", "DIVIDE": "div", "MINIMUM": "min", "MAXIMUM": "max",
         "ABSOLUTE": "abs", "FLOOR": "floor", "FRACTION": "fract", "SINE": "sin", "COSINE": "cos", "NORMALIZE": "normalize"}
LUMA = (0.2126, 0.7152, 0.0722)  # Blender's default (Rec. 709) weights when a colour plugs into a number


class Importer:
    def __init__(self, name):
        self.name = name
        self.nodes = []
        self.params = []
        self.problems = []
        self.memo = {}
        self.n = 0
        self.used_ids = set()
        self.known = {}
        self.source = None

    def add(self, op, ins=None, st=None):
        nid = "n%d" % self.n
        self.n += 1
        node = {"id": nid, "op": op}
        if ins:
            node["in"] = ins
        if st:
            node["set"] = st
        self.nodes.append(node)
        return nid

    def pid(self, label):
        base = "".join(c if c.isalnum() else "_" for c in label).strip("_").lower() or "param"
        pid, k = base, 2
        while pid in self.used_ids:
            pid, k = "%s_%d" % (base, k), k + 1
        self.used_ids.add(pid)
        return pid

    def param(self, label, kind, default, lo=None, hi=None):
        known = self.known.get(label)  # the graph Inoscula stored on the group, if any: keeps ids and ranges stable
        if known and known["id"] not in self.used_ids:
            self.used_ids.add(known["id"])
            p = {k: v for k, v in known.items() if k != "default"}
            p["default"] = default
            self.params.append(p)
            return "$" + p["id"]
        p = {"id": self.pid(label), "type": kind, "default": default, "label": label}
        if lo is not None and hi is not None and lo > -1e30 and hi < 1e30:
            p["min"], p["max"] = lo, hi
        self.params.append(p)
        return "$" + p["id"]

    # ---- values flowing into an input socket
    def input(self, sock, ctx, want=None):
        """A wire for an input socket: what is linked into it, or its own value."""
        links = [l for l in sock.links if l.is_valid and not l.is_muted] if sock.is_linked else []
        if links:
            w, kind = self.output(links[0].from_socket, ctx)
            return self.convert(w, kind, want or kind_of(sock))
        return literal(sock, want)

    def convert(self, w, have, want):
        if have == want or want is None:
            return w
        if want == "float" and have in ("vec3", "color"):
            weights = list(LUMA) if have == "color" else [1 / 3, 1 / 3, 1 / 3]
            return self.add("dot", {"a": w, "b": weights})
        return w  # float -> vector is automatic in Inoscula too

    def output(self, sock, ctx):
        """(wire, kind) for an output socket. kind is float, vec3 or color."""
        key = (sock.as_pointer(), id(ctx))
        if key in self.memo:
            return self.memo[key]
        r = self._output(sock, ctx)
        self.memo[key] = r
        return r

    def _output(self, sock, ctx):
        nd = sock.node
        t = nd.bl_idname
        I = lambda name, want=None: self.input(socket(nd.inputs, name), ctx, want)
        # Inoscula's own input nodes, by their labels (shape data and object size)
        SOURCES = {"Inoscula Curvature": "curvature", "Inoscula Occlusion": "occlusion", "Inoscula Object Size": "object_size"}
        if nd.label in SOURCES:
            return self.add(SOURCES[nd.label]), "float"
        if t == "ShaderNodeAttribute" and nd.attribute_name == "inoscula_object_size":
            return self.add("object_size"), "float"
        if t == "NodeReroute":
            return self.output_of_input(nd.inputs[0], ctx)
        if t == "NodeGroupInput":
            return ctx["group_in"](sock.identifier)
        if t == "ShaderNodeGroup":
            return self.group(nd, sock, ctx)
        if t == "ShaderNodeTexCoord":
            if nd.object is not None:
                return self.unsupported(nd, "Texture Coordinate set to another object")
            m = {"UV": "uv", "Object": "object_pos", "Normal": "object_normal"}
            if sock.identifier in m:
                return self.add(m[sock.identifier]), "vec3"
            return self.unsupported(nd, "Texture Coordinate > " + sock.identifier)
        if t == "ShaderNodeNewGeometry":
            m = {"Position": "world_pos", "Normal": "normal", "Incoming": "view_dir"}
            if sock.identifier in m:
                return self.add(m[sock.identifier]), "vec3"
            return self.unsupported(nd, "Geometry > " + sock.identifier)
        if t == "ShaderNodeValue" and nd.label == "Time (seconds)":
            return self.add("time"), "float"
        if t == "ShaderNodeValue":
            return self.param(nd.label or nd.name, "float", sock.default_value), "float"
        if t == "ShaderNodeRGB":
            return self.param(nd.label or nd.name, "color", list(sock.default_value)[:3]), "color"
        if t == "ShaderNodeMath":
            op = nd.operation
            if op in MATH:
                UNARY = ("ABSOLUTE", "FLOOR", "FRACT", "SINE", "COSINE", "EXPONENT", "SQRT")
                ins = {"a": I(0, "float")} if op in UNARY else {"a": I(0, "float"), "b": I(1, "float")}
                if op in UNARY:
                    ins = {"x": ins["a"]}
                w = self.add(MATH[op], ins)
            elif op == "ARCTAN2":
                w = self.add("atan2", {"y": I(0, "float"), "x": I(1, "float")})
            elif op == "LESS_THAN":
                w = self.add("greater", {"a": I(1, "float"), "b": I(0, "float")})
            elif op == "MULTIPLY_ADD":
                w = self.add("add", {"a": self.add("mul", {"a": I(0, "float"), "b": I(1, "float")}), "b": I(2, "float")})
            else:
                return self.unsupported(nd, "Math > " + op.title().replace("_", " "))
            if nd.use_clamp:
                w = self.add("clamp", {"x": w, "lo": 0.0, "hi": 1.0})
            return w, "float"
        if t == "ShaderNodeVectorMath":
            op = nd.operation
            if op == "DOT_PRODUCT":
                return self.add("dot", {"a": I(0, "vec3"), "b": I(1, "vec3")}), "float"
            if op == "LENGTH":
                return self.add("length", {"x": I(0, "vec3")}), "float"
            if op == "SCALE":
                return self.add("mul", {"a": I(0, "vec3"), "b": self.input(socket(nd.inputs, "Scale"), ctx, "float")}), "vec3"
            if op in VMATH:
                one = op in ("ABSOLUTE", "FLOOR", "FRACTION", "SINE", "COSINE", "NORMALIZE")
                ins = {"x": I(0, "vec3")} if one else {"a": I(0, "vec3"), "b": I(1, "vec3")}
                return self.add(VMATH[op], ins), "vec3"
            return self.unsupported(nd, "Vector Math > " + op.title().replace("_", " "))
        if t == "ShaderNodeClamp":
            if nd.clamp_type != "MINMAX":
                return self.unsupported(nd, "Clamp > Range")
            return self.add("clamp", {"x": I("Value", "float"), "lo": I("Min", "float"), "hi": I("Max", "float")}), "float"
        if t == "ShaderNodeMix":
            dt = nd.data_type
            if dt == "RGBA" and nd.blend_type != "MIX":
                return self.unsupported(nd, "Mix > " + nd.blend_type.title())
            if dt != "FLOAT" and getattr(nd, "factor_mode", "UNIFORM") != "UNIFORM":
                return self.unsupported(nd, "Mix with a non-uniform factor")
            if not nd.clamp_factor:
                self.note(nd, "factor is not clamped in Blender; Inoscula clamps it to 0..1")
            k = {"FLOAT": "Float", "VECTOR": "Vector", "RGBA": "Color"}[dt]
            want = "float" if dt == "FLOAT" else "vec3"
            w = self.add("mix", {"t": self.input(socket(nd.inputs, "Factor_Float"), ctx, "float"),
                                 "a": self.input(socket(nd.inputs, "A_" + k), ctx, want),
                                 "b": self.input(socket(nd.inputs, "B_" + k), ctx, want)})
            if dt == "RGBA" and nd.clamp_result:
                w = self.add("clamp", {"x": w, "lo": 0.0, "hi": 1.0})
            return w, ("float" if dt == "FLOAT" else "color" if dt == "RGBA" else "vec3")
        if t == "ShaderNodeMapRange" and nd.data_type == "FLOAT":
            x, a, b = I("Value", "float"), I("From Min", "float"), I("From Max", "float")
            c, d = I("To Min", "float"), I("To Max", "float")
            if nd.interpolation_type == "SMOOTHSTEP":
                f = self.add("smoothstep", {"e0": a, "e1": b, "x": x})
            elif nd.interpolation_type == "LINEAR":
                f = self.add("div", {"a": self.add("sub", {"a": x, "b": a}), "b": self.add("sub", {"a": b, "b": a})})
                if nd.clamp:
                    f = self.add("clamp", {"x": f, "lo": 0.0, "hi": 1.0})
            else:
                return self.unsupported(nd, "Map Range > " + nd.interpolation_type.title())
            return self.add("add", {"a": c, "b": self.add("mul", {"a": f, "b": self.add("sub", {"a": d, "b": c})})}), "float"
        if t in ("ShaderNodeCombineXYZ", "ShaderNodeCombineColor"):
            if t == "ShaderNodeCombineColor" and nd.mode != "RGB":
                return self.unsupported(nd, "Combine Color > " + nd.mode)
            return self.add("combine", {"x": I(0, "float"), "y": I(1, "float"), "z": I(2, "float")}), ("vec3" if t.endswith("XYZ") else "color")
        if t in ("ShaderNodeSeparateXYZ", "ShaderNodeSeparateColor"):
            if t == "ShaderNodeSeparateColor" and nd.mode != "RGB":
                return self.unsupported(nd, "Separate Color > " + nd.mode)
            s = self.add("separate", {"v": I(0, "vec3")})
            idx = list(nd.outputs).index(sock)
            return "%s.%s" % (s, "xyz"[idx]), "float"
        if t == "ShaderNodeValToRGB":
            r = nd.color_ramp
            if r.interpolation not in ("LINEAR", "CONSTANT"):
                return self.unsupported(nd, "Color Ramp > " + r.interpolation.title())
            if r.color_mode != "RGB":
                return self.unsupported(nd, "Color Ramp in " + r.color_mode + " mode")
            stops = [[e.position, list(e.color)[:3]] for e in r.elements]
            w = self.add("ramp", {"t": I("Fac", "float")}, {"mode": r.interpolation.lower(), "stops": stops})
            if sock.identifier == "Alpha":
                return self.unsupported(nd, "Color Ramp > Alpha")
            return w, "color"
        if t == "ShaderNodeTexWhiteNoise":
            if nd.noise_dimensions != "3D" or sock.identifier != "Value":
                return self.unsupported(nd, "White Noise that is not 3D > Value")
            return self.add("white_noise", {"p": I("Vector", "vec3")}), "float"
        if t == "ShaderNodeTexNoise":
            normalize = nd.normalize if hasattr(nd, "normalize") else socket(nd.inputs, "Normalize").default_value
            if nd.noise_dimensions != "3D" or getattr(nd, "noise_type", "FBM") != "FBM" or not normalize:
                return self.unsupported(nd, "Noise Texture that is not 3D, fBM, normalised")
            if sock.identifier != "Fac":
                return self.unsupported(nd, "Noise Texture > Color")
            dist = socket(nd.inputs, "Distortion")
            if dist.is_linked or dist.default_value != 0:
                return self.unsupported(nd, "Noise Texture with Distortion")
            vec = socket(nd.inputs, "Vector")
            p = self.input(vec, ctx, "vec3") if vec.is_linked else self.unsupported(nd, "Noise Texture with no Vector (Generated coordinates)")[0]
            return self.add("noise", {"p": p, "scale": I("Scale", "float"), "detail": I("Detail", "float"),
                                      "roughness": I("Roughness", "float"), "lacunarity": I("Lacunarity", "float")}), "float"
        if t == "ShaderNodeTexVoronoi":
            if nd.voronoi_dimensions != "3D" or nd.feature != "F1" or nd.distance != "EUCLIDEAN":
                return self.unsupported(nd, "Voronoi Texture that is not 3D, F1, Euclidean")
            det = socket(nd.inputs, "Detail") if "Detail" in nd.inputs else None
            if det is not None and (det.is_linked or det.default_value != 0):
                return self.unsupported(nd, "Voronoi Texture with Detail")
            key = ("voronoi", nd.as_pointer(), id(ctx))
            if key not in self.memo:
                vec = socket(nd.inputs, "Vector")
                p = self.input(vec, ctx, "vec3") if vec.is_linked else self.unsupported(nd, "Voronoi Texture with no Vector (Generated coordinates)")[0]
                self.memo[key] = self.add("voronoi", {"p": p, "scale": I("Scale", "float"), "randomness": I("Randomness", "float")})
            v = self.memo[key]
            out = {"Distance": (v, "float"), "Color": (v + ".color", "color"), "Position": (v + ".position", "vec3")}
            if sock.identifier not in out:
                return self.unsupported(nd, "Voronoi Texture > " + sock.identifier)
            return out[sock.identifier]
        return self.unsupported(nd, nd.bl_label or t)

    def output_of_input(self, inp, ctx):
        if inp.is_linked:
            return self.output(inp.links[0].from_socket, ctx)
        return literal(inp, None), kind_of(inp)

    def group(self, nd, sock, ctx):
        tree = nd.node_tree
        outer = self
        stored = tree.get("inoscula_graph") if hasattr(tree, "get") else None
        if stored and self.source is None:
            try:
                self.source = json.loads(stored)
                for prm in self.source.get("params", []):
                    self.known[prm.get("label", prm["id"])] = prm
            except Exception:
                pass

        def group_in(identifier):
            inner = next(s for s in nd.inputs if s.identifier == identifier)
            if inner.name in ("Light Direction", "Light Color"):  # the lighting contract Inoscula itself writes
                return outer.add("light_dir" if inner.name == "Light Direction" else "light_color"), "vec3"
            if inner.is_linked:
                w, k = outer.output(inner.links[0].from_socket, ctx)
                return w, k
            item = next((i for i in tree.interface.items_tree if getattr(i, "identifier", None) == identifier), None)
            k = kind_of(inner)
            if k == "float":
                lo = getattr(item, "min_value", None) if item else None
                hi = getattr(item, "max_value", None) if item else None
                return outer.param(inner.name, "float", inner.default_value, lo, hi), "float"
            v = list(inner.default_value)[:3]
            return outer.param(inner.name, "color" if k == "color" else "vector", v), k
        cache = {}

        def cached_in(identifier):
            if identifier not in cache:
                cache[identifier] = group_in(identifier)
            return cache[identifier]
        sub = {"group_in": cached_in}
        gout = next((n for n in tree.nodes if n.bl_idname == "NodeGroupOutput" and n.is_active_output), None) or \
            next(n for n in tree.nodes if n.bl_idname == "NodeGroupOutput")
        target = next(s for s in gout.inputs if s.identifier == sock.identifier)
        key = ("group", nd.as_pointer())
        if key not in self.memo:
            self.memo[key] = sub
        return self.output_of_input(target, self.memo[key])

    def unsupported(self, nd, what):
        self.problems.append("%s (node \"%s\")" % (what, nd.name))
        return 0.0, "float"

    def note(self, nd, what):
        self.problems.append("note: %s: %s" % (nd.name, what))


def socket(socks, key):
    if isinstance(key, int):
        enabled = [s for s in socks if s.enabled]
        return enabled[key]
    for s in socks:
        if s.identifier == key:
            return s
    for s in socks:
        if s.name == key and s.enabled:
            return s
    raise KeyError(key)


def kind_of(sock):
    return {"VALUE": "float", "INT": "float", "BOOLEAN": "float", "VECTOR": "vec3", "RGBA": "color"}.get(sock.type, "float")


def literal(sock, want):
    v = getattr(sock, "default_value", 0.0)
    try:
        v = list(v)[:3]
        v = [float(x) for x in v]
        if want == "float":
            return sum(v) / 3.0
        return v
    except TypeError:
        return float(v)


def surface_color(imp, mat):
    nt = mat.node_tree
    out = next((n for n in nt.nodes if n.bl_idname == "ShaderNodeOutputMaterial" and n.is_active_output), None)
    if out is None or not out.inputs["Surface"].is_linked:
        raise RuntimeError("The material has no connected Material Output.")
    ctx = {"group_in": lambda i: (0.0, "float")}

    def shader(s):
        nd = s.node
        t = nd.bl_idname
        if t == "ShaderNodeEmission":
            col = imp.input(socket(nd.inputs, "Color"), ctx, "vec3")
            st = socket(nd.inputs, "Strength")
            if st.is_linked or st.default_value != 1.0:
                col = imp.add("mul", {"a": col, "b": imp.input(st, ctx, "float")})
            return col, None
        if t == "ShaderNodeMixShader":
            a, b = nd.inputs[1], nd.inputs[2]
            if a.is_linked and a.links[0].from_node.bl_idname == "ShaderNodeBsdfTransparent" and b.is_linked:
                col, _ = shader(b.links[0].from_socket)
                return col, imp.input(nd.inputs[0], ctx, "float")
        if t == "ShaderNodeBsdfPrincipled":
            # a physically based surface: read every channel Inoscula knows
            lit = imp.lit
            lit["roughness"] = imp.input(socket(nd.inputs, "Roughness"), ctx, "float")
            lit["metallic"] = imp.input(socket(nd.inputs, "Metallic"), ctx, "float")
            em = socket(nd.inputs, "Emission Color")
            if em.is_linked:
                lit["emission"] = imp.input(em, ctx, "vec3")
            for key, nm in (("coat", "Coat Weight"), ("coat_roughness", "Coat Roughness"), ("sheen", "Sheen Weight"), ("sheen_roughness", "Sheen Roughness"), ("subsurface", "Subsurface Weight")):
                so = socket(nd.inputs, nm)
                if so.is_linked or (key in ("coat", "sheen", "subsurface") and so.default_value > 0):
                    lit[key] = imp.input(so, ctx, "float")
            st = socket(nd.inputs, "Sheen Tint")
            if "sheen" in lit:
                lit["sheen_color"] = imp.input(st, ctx, "vec3")
            nrm = socket(nd.inputs, "Normal")
            if nrm.is_linked:
                bn = nrm.links[0].from_node
                if bn.bl_idname == "ShaderNodeBump" and socket(bn.inputs, "Height").is_linked:
                    h = imp.input(socket(bn.inputs, "Height"), ctx, "float")
                    dist = socket(bn.inputs, "Distance").default_value * socket(bn.inputs, "Strength").default_value
                    lit["bump"] = h if dist == 1.0 else imp.add("mul", {"a": h, "b": dist})
                else:
                    imp.problems.append("note: only a Bump node (Height) is read into the Normal input; normal maps come with image textures, which are not supported yet")
            alpha = socket(nd.inputs, "Alpha")
            return imp.input(socket(nd.inputs, "Base Color"), ctx, "vec3"), (imp.input(alpha, ctx, "float") if alpha.is_linked else None)
        if t == "ShaderNodeBsdfDiffuse":
            imp.problems.append("note: Diffuse BSDF is lit by the renderer; Inoscula takes its Color as an unlit look")
            return imp.input(socket(nd.inputs, "Color"), ctx, "vec3"), None
        if t == "NodeReroute":
            return shader(nd.inputs[0].links[0].from_socket)
        imp.problems.append("%s as the surface shader" % nd.bl_label)
        return [1.0, 0.0, 1.0], None
    return shader(out.inputs["Surface"].links[0].from_socket)


def material_to_inoscula(mat):
    imp = Importer(mat.name)
    imp.lit = {}
    color, alpha = surface_color(imp, mat)
    name = imp.source.get("name", mat.name) if imp.source else mat.name
    g = {"inoscula": "0.1", "name": name, "params": imp.params, "nodes": imp.nodes, "output": {"color": color}}
    if alpha is not None:
        g["output"]["alpha"] = alpha
    if imp.lit:
        g["shading"] = "lit"
        g["output"].update(imp.lit)
    # settings that live outside the node tree (cutout, brush cards, rim shells, the outline pass) come back from
    # the graph stored in the group; the outline keeps any parameter it is wired to
    src = imp.source or {}
    for key in ("surface", "cards", "shells"):
        if key in src:
            g[key] = src[key]
    ids = {p["id"] for p in g["params"]}
    for key in ("outline", "outline_color", "outline_breakup", "outline_rings"):
        v = src.get("output", {}).get(key)
        if v is None:
            continue
        if isinstance(v, str) and v.startswith("$") and v[1:] not in ids:
            prm = next((p for p in src.get("params", []) if p["id"] == v[1:]), None)
            if prm is None:
                continue
            g["params"].append(prm)
        g["output"][key] = v
    return g, [p for p in imp.problems]


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if argv:
        mat = bpy.data.materials[argv[0]]
        out = argv[1] if len(argv) > 1 else mat.name + ".inoscula.json"
    else:
        ob = bpy.context.active_object
        mat = ob.active_material if ob else None
        if mat is None:
            raise RuntimeError("Select an object with a material first.")
        folder = os.path.dirname(bpy.data.filepath) or os.path.expanduser("~")
        out = os.path.join(folder, mat.name + ".inoscula.json")
    g, problems = material_to_inoscula(mat)
    text = json.dumps(g, indent=2)
    with open(out, "w") as f:
        f.write(text)
    try:
        bpy.context.window_manager.clipboard = text
    except Exception:
        pass
    print("Inoscula: wrote %s (%d nodes, %d parameters)" % (out, len(g["nodes"]), len(g["params"])))
    for p in problems:
        print("Inoscula: " + p)


if __name__ == "__main__":
    main()
