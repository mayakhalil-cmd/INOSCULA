# Render check, Godot side: the same scene as render_blender.py, in Godot's own renderer, with the .gdshader
# Inoscula made.   godot --path <this folder> --rendering-method forward_plus -s render_godot.gd -- <shader.gdshader> <out.png>
extends SceneTree

func _initialize() -> void:
	_run.call_deferred()

func _to_godot(v: Vector3) -> Vector3:
	return Vector3(v.x, v.z, -v.y) # Blender (Z up) to Godot (Y up)

# brush cards from inoscula-check (positions, normals, uvs, indices), drawn with the look's material
func _cards(k: Dictionary, mat: Material) -> MeshInstance3D:
	var arr := []
	arr.resize(Mesh.ARRAY_MAX)
	var p := PackedVector3Array()
	var n := PackedVector3Array()
	var u := PackedVector2Array()
	var idx := PackedInt32Array()
	for j in range(0, k["p"].size(), 3):
		p.append(Vector3(k["p"][j], k["p"][j + 1], k["p"][j + 2]))
		n.append(Vector3(k["n"][j], k["n"][j + 1], k["n"][j + 2]))
	for j in range(0, k["u"].size(), 2):
		u.append(Vector2(k["u"][j], 1.0 - k["u"][j + 1]))
	var tri: Array = k["i"]
	for j in range(0, tri.size(), 3):
		# Godot's front faces wind the other way
		idx.append(int(tri[j])); idx.append(int(tri[j + 2])); idx.append(int(tri[j + 1]))
	arr[Mesh.ARRAY_VERTEX] = p
	arr[Mesh.ARRAY_NORMAL] = n
	arr[Mesh.ARRAY_TEX_UV] = u
	arr[Mesh.ARRAY_INDEX] = idx
	var am := ArrayMesh.new()
	am.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arr)
	var mi := MeshInstance3D.new()
	mi.mesh = am
	mi.material_override = mat
	return mi

func _run() -> void:
	var args := OS.get_cmdline_user_args()
	var vp := SubViewport.new()
	vp.size = Vector2i(640, 480)
	vp.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	vp.msaa_3d = Viewport.MSAA_4X
	root.add_child(vp)
	var env := Environment.new()
	# a sky of one even color, like Blender's world: lights and reflects
	var skym := ProceduralSkyMaterial.new()
	var c := Color(0.35, 0.42, 0.55).linear_to_srgb()
	skym.sky_top_color = c
	skym.sky_horizon_color = c
	skym.ground_horizon_color = c
	skym.ground_bottom_color = c
	skym.sky_energy_multiplier = 0.6
	skym.sun_angle_max = 0.0
	var sky := Sky.new()
	sky.sky_material = skym
	env.sky = sky
	env.background_mode = Environment.BG_SKY
	env.ambient_light_source = Environment.AMBIENT_SOURCE_SKY
	env.reflected_light_source = Environment.REFLECTION_SOURCE_SKY
	env.tonemap_mode = Environment.TONE_MAPPER_AGX
	var we := WorldEnvironment.new()
	we.environment = env
	vp.add_child(we)
	var sun := DirectionalLight3D.new()
	sun.light_energy = 3.5 / PI # Godot's light energy is radiance-like; Blender's sun strength is irradiance
	sun.shadow_enabled = true
	vp.add_child(sun)
	var to_light := _to_godot(Vector3(-0.5, -0.6, 0.62)).normalized()
	sun.look_at_from_position(Vector3.ZERO, -to_light, Vector3.UP)
	var cam := Camera3D.new()
	cam.fov = 39.6 # matches a 50mm lens on Blender's default 36mm sensor, horizontally
	cam.keep_aspect = Camera3D.KEEP_WIDTH
	vp.add_child(cam)
	cam.look_at_from_position(_to_godot(Vector3(0, -6.2, 1.6)), _to_godot(Vector3(0, 0, 0.9)), Vector3.UP)
	var sh := Shader.new()
	sh.code = FileAccess.get_file_as_string(args[0])
	var mat := ShaderMaterial.new()
	mat.shader = sh
	if args.size() > 2 and args[2] != "":
		var osh := Shader.new()
		osh.code = FileAccess.get_file_as_string(args[2])
		var omat := ShaderMaterial.new()
		omat.shader = osh
		mat.next_pass = omat
	var ball := MeshInstance3D.new()
	var sm := SphereMesh.new()
	sm.radial_segments = 96
	sm.rings = 48
	sm.radius = 1.0
	sm.height = 2.0
	ball.mesh = sm
	ball.position = _to_godot(Vector3(-1.15, 0, 1.0))
	ball.material_override = mat
	vp.add_child(ball)
	var tor := MeshInstance3D.new()
	var bx := BoxMesh.new()
	bx.size = Vector3(1.5, 1.5, 1.5)
	bx.subdivide_width = 24
	bx.subdivide_height = 24
	bx.subdivide_depth = 24
	tor.mesh = bx
	tor.position = _to_godot(Vector3(1.15, 0, 0.75))
	tor.rotation = Vector3(0, deg_to_rad(30), 0)
	tor.material_override = mat
	vp.add_child(tor)
	if sh.code.find("inoscula_object_size") != -1:
		ball.set_instance_shader_parameter("inoscula_object_size", 2.0 * sqrt(3.0))
		tor.set_instance_shader_parameter("inoscula_object_size", 1.5 * sqrt(3.0))
	if args.size() > 3 and args[3] != "":
		var cj = JSON.parse_string(FileAccess.get_file_as_string(args[3]))
		for pair in [[ball, cj["ball"]], [tor, cj["box"]]]:
			pair[0].add_child(_cards(pair[1], mat))
	var floor := MeshInstance3D.new()
	var pm := PlaneMesh.new()
	pm.size = Vector2(40, 40)
	floor.mesh = pm
	var fmat := StandardMaterial3D.new()
	fmat.albedo_color = Color(0.32, 0.32, 0.32).linear_to_srgb()
	fmat.roughness = 0.9
	floor.material_override = fmat
	vp.add_child(floor)
	for p in mat.shader.get_shader_uniform_list():
		if p["name"] == "inoscula_light_dir":
			mat.set_shader_parameter("inoscula_light_dir", to_light)
	for i in 8:
		await process_frame
	var img := vp.get_texture().get_image()
	img.save_png(args[1])
	print("Inoscula: rendered ", args[1])
	quit()
