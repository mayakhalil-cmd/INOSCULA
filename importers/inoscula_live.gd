# Inoscula Live for Godot 4. Add this script to any node in your scene. With Inoscula Live running
# (node bin/inoscula-live.ts), every Inoscula ShaderMaterial in the scene follows parameter changes from Inoscula
# Studio, RICO, Blender and Unreal, and changes you make in the Inspector go out to all of them.
@tool
extends Node

@export var listen_port := 9422
@export var send_port := 9419
var _udp := PacketPeerUDP.new()
var _out := PacketPeerUDP.new()
var _seen := {}
var _timer := 0.0

func _ready() -> void:
	_udp.bind(listen_port, "127.0.0.1")
	_out.set_dest_address("127.0.0.1", send_port)

func _materials(n: Node, acc: Array) -> Array:
	if n is GeometryInstance3D:
		var mats: Array = []
		if n.material_override != null:
			mats.append(n.material_override)
		if n is MeshInstance3D and n.mesh != null:
			for i in n.mesh.get_surface_count():
				var m = n.get_active_material(i)
				if m != null:
					mats.append(m)
		for m in mats:
			if m is ShaderMaterial and m.shader != null and not acc.has(m):
				acc.append(m)
	for c in n.get_children():
		_materials(c, acc)
	return acc

func _graph(m: ShaderMaterial) -> Dictionary:
	for line in m.shader.code.split("\n"):
		if line.begins_with("// inoscula-graph: "):
			var g = JSON.parse_string(line.substr(16))
			return g if g is Dictionary else {}
	return {}

func _root() -> Node:
	return get_tree().edited_scene_root if Engine.is_editor_hint() else get_tree().current_scene

func apply(msg: Dictionary) -> int:
	var hits := 0
	for m in _materials(_root(), []):
		var g := _graph(m)
		if g.get("name", "") != msg.get("material", ""):
			continue
		for p in g.get("params", []):
			if p["id"] != msg["param"] and p.get("label", "") != msg["param"]:
				continue
			var v = msg["value"]
			if v is Array:
				var c := Color(v[0], v[1], v[2])
				m.set_shader_parameter("p_" + p["id"], c.linear_to_srgb() if p["type"] == "color" else Vector3(v[0], v[1], v[2]))
			else:
				m.set_shader_parameter("p_" + p["id"], float(v))
			_seen[g["name"] + "/" + p["id"]] = v
			hits += 1
	return hits

func _process(delta: float) -> void:
	while _udp.get_available_packet_count() > 0:
		var msg = JSON.parse_string(_udp.get_packet().get_string_from_utf8())
		if msg is Dictionary:
			apply(msg)
	_timer += delta
	if _timer < 0.1:
		return
	_timer = 0.0
	for m in _materials(_root(), []):
		var g := _graph(m)
		if g.is_empty():
			continue
		for p in g.get("params", []):
			var raw = m.get_shader_parameter("p_" + p["id"])
			if raw == null:
				continue
			var v
			if raw is Color:
				var l: Color = raw.srgb_to_linear()
				v = [l.r, l.g, l.b]
			elif raw is Vector3:
				v = [raw.x, raw.y, raw.z]
			else:
				v = float(raw)
			var key: String = g["name"] + "/" + p["id"]
			if _seen.has(key) and str(_seen[key]) != str(v):
				_out.put_packet(JSON.stringify({"material": g["name"], "param": p["id"], "value": v, "from": "godot"}).to_utf8_buffer())
			_seen[key] = v
