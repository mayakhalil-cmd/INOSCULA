# Inoscula Live for Blender. Install: Edit > Preferences > Add-ons > Install from Disk, pick this file, tick it.
# With Inoscula Live running (node bin/inoscula-live.ts), every Inoscula material in the open file follows parameter
# changes from Inoscula Studio, RICO, Godot and Unreal, and changes you make here go out to all of them.
bl_info = {"name": "Inoscula Live", "author": "Inoscula", "version": (0, 3, 0), "blender": (4, 0, 0), "category": "Material",
           "description": "Live parameter link between Inoscula materials in Blender and other tools"}
import bpy, json, socket

LISTEN = 9421   # Inoscula Live sends to Blender here
SEND = 9419     # Blender sends its own changes here
_sock = None
_seen = {}      # (material, param) -> last value, so we only send real changes


def _graphs():
    """Inoscula node groups in this file: group -> its stored graph."""
    out = {}
    for g in bpy.data.node_groups:
        raw = g.get("inoscula_graph") if hasattr(g, "get") else None
        if raw:
            try:
                out[g] = json.loads(raw)
            except Exception:
                pass
    return out


def _instances(group):
    for m in bpy.data.materials:
        if m.node_tree is None:
            continue
        for n in m.node_tree.nodes:
            if n.bl_idname == "ShaderNodeGroup" and n.node_tree == group:
                yield n


def _value(sock):
    v = sock.default_value
    try:
        return [float(x) for x in list(v)[:3]]
    except TypeError:
        return float(v)


def apply(msg):
    """Set a parameter from a Inoscula Live message on every material that uses that Inoscula graph."""
    hits = 0
    for group, graph in _graphs().items():
        if graph.get("name") != msg.get("material"):
            continue
        prm = next((p for p in graph.get("params", []) if p["id"] == msg.get("param") or p.get("label") == msg.get("param")), None)
        if prm is None:
            continue
        label = prm.get("label", prm["id"])
        for node in _instances(group):
            sock = node.inputs.get(label)
            if sock is None:
                continue
            v = msg["value"]
            if isinstance(v, list):
                sock.default_value = (v[0], v[1], v[2], 1.0) if sock.type == "RGBA" else (v[0], v[1], v[2])
            else:
                sock.default_value = float(v)
            hits += 1
            _seen[(graph["name"], prm["id"])] = _value(sock)  # as Blender stores it, so it is not echoed back
    return hits


def changes():
    """Parameters changed by hand in Blender since the last look."""
    out = []
    for group, graph in _graphs().items():
        for prm in graph.get("params", []):
            label = prm.get("label", prm["id"])
            for node in _instances(group):
                sock = node.inputs.get(label)
                if sock is None:
                    continue
                v = _value(sock)
                key = (graph["name"], prm["id"])
                if key in _seen and _seen[key] != v:
                    out.append({"material": graph["name"], "param": prm["id"], "value": v, "from": "blender"})
                _seen[key] = v
                break
    return out


def poll():
    global _sock
    if _sock is None:
        return None
    try:
        while True:
            data, _ = _sock.recvfrom(65536)
            apply(json.loads(data.decode()))
    except (BlockingIOError, OSError):
        pass
    for m in changes():
        _sock.sendto(json.dumps(m).encode(), ("127.0.0.1", SEND))
    return 0.05


def register():
    global _sock
    _sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    _sock.bind(("127.0.0.1", LISTEN))
    _sock.setblocking(False)
    changes()  # remember the starting values
    bpy.app.timers.register(poll, persistent=True)


def unregister():
    global _sock
    if bpy.app.timers.is_registered(poll):
        bpy.app.timers.unregister(poll)
    if _sock is not None:
        _sock.close()
        _sock = None


if __name__ == "__main__":
    register()
