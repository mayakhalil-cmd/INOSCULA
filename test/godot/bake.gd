# Parity test, Godot side: draws each mesh flattened into UV space with the .gdshader Inoscula made and saves
# the linear float pixels.  godot --path . --rendering-driver opengl3 -s bake.gd -- job.json
extends SceneTree

func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	var job: Array = JSON.parse_string(FileAccess.get_file_as_string(OS.get_cmdline_user_args()[0]))
	var vp := SubViewport.new()
	vp.size = Vector2i(256, 256)
	vp.use_hdr_2d = true
	vp.transparent_bg = true
	vp.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	root.add_child(vp)
	var cam := Camera3D.new()
	var env := Environment.new()
	env.tonemap_mode = Environment.TONE_MAPPER_LINEAR
	env.background_mode = Environment.BG_CLEAR_COLOR
	cam.environment = env
	vp.add_child(cam)
	cam.position = Vector3(0, 0, 10)
	for item in job:
		var m: Dictionary = item.mesh
		var P := PackedVector3Array(); var N := PackedVector3Array(); var U := PackedVector2Array()
		var pos: Array = m.pos; var nrm: Array = m.nrm; var uv: Array = m.uv
		for i in range(0, pos.size(), 3):
			# Blender (Z up) to Godot (Y up): (x, y, z) -> (x, z, -y)
			P.append(Vector3(pos[i], pos[i + 2], -pos[i + 1]))
			N.append(Vector3(nrm[i], nrm[i + 2], -nrm[i + 1]))
		for i in range(0, uv.size(), 2):
			U.append(Vector2(uv[i], 1.0 - uv[i + 1])) # as a glTF import would store it
		var arrays := []
		arrays.resize(Mesh.ARRAY_MAX)
		arrays[Mesh.ARRAY_VERTEX] = P; arrays[Mesh.ARRAY_NORMAL] = N; arrays[Mesh.ARRAY_TEX_UV] = U
		var mesh := ArrayMesh.new()
		mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
		var mi := MeshInstance3D.new()
		mi.mesh = mesh
		mi.custom_aabb = AABB(Vector3(-1e4, -1e4, -1e4), Vector3(2e4, 2e4, 2e4))
		var t: Array = item.xform
		mi.transform = Transform3D(Basis(Vector3(t[0], t[1], t[2]), Vector3(t[3], t[4], t[5]), Vector3(t[6], t[7], t[8])), Vector3(t[9], t[10], t[11]))
		var sh := Shader.new()
		sh.code = FileAccess.get_file_as_string(item.shader)
		var mat := ShaderMaterial.new()
		mat.shader = sh
		mi.material_override = mat
		vp.add_child(mi)
		for i in 5:
			await process_frame
		var img := vp.get_texture().get_image()
		img.convert(Image.FORMAT_RGBAF)
		var f := FileAccess.open(item.out, FileAccess.WRITE)
		f.store_buffer(img.get_data())
		f.close()
		print("godot baked ", item.out)
		mi.queue_free()
		await process_frame
	quit()
