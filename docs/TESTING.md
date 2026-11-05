# Testing Inoscula in each program

Do these once on your own machine. Each step says what you should see, so anything off is easy to spot and
report. Start with one stylized look (Paint Bands) and one lit look (Claymation).

## 0. Inoscula Studio

1. Open `dist/inoscula-studio.html` in Chrome, Firefox or Safari.
2. Pick **Claymation**, then File, **Import model…** and choose any .glb of yours. Press **Prepare model**: edges
   chip and crevices darken. Press **Save model** to get `<name>.inoscula.glb`.
3. Switch **Preview as** between RICO, Blender, Unreal, Godot and Unity: the tonemapping changes, the material
   does not.
4. Switch to **Nodes** and double-click a node: the code view jumps to that line.
5. Open the **Check** tab: each program is listed with how closely it matches and what to do about anything that
   does not.

## 1. Blender (4.2 or later)

1. In Inoscula Studio, open the **Blender** tab and press Save file (or Copy and paste into a new text block).
2. Blender: Scripting workspace, Text Editor, open the file, Run Script.
3. You should see the material "Claymation" and the node group "Inoscula Claymation", with all the sliders on
   the group node. Assign it to your `.inoscula.glb` model (File, Import, glTF).
4. Add a Sun light and rename it "RICO Sun": shaders that use the light direction follow it.
5. Render in Eevee and Cycles. Compare with Inoscula Studio set to **Preview as: Blender**.
6. **Round trip:** change some group values and a node or two, select the object, run
   `importers/blender_to_inoscula.py`. Paste the `.inoscula.json` it writes into Inoscula Studio (File, Import graph). Your
   changes are in the code.

## 2. Godot (4.4 or later)

1. Save the **Godot** tab (VisualShader nodes) as `claymation.tres` in your project, or pick Shader code and save
   `claymation.gdshader`. New ShaderMaterial, set Shader to it.
2. Import your `.inoscula.glb` and assign the material. Parameters appear in the Inspector.
3. Add `inoscula_light_bridge.gd` to any node, point it at your DirectionalLight3D.
4. Compare with Inoscula Studio set to **Preview as: Godot**, or run the Render check (section 6).
5. **Round trip:** change values in the Inspector, save the material as .tres, then
   `node bin/inoscula-pull.ts claymation.tres claymation.gdshader`.

## 3. Unreal (5.4 or later)

This is the least tested target, so check it carefully.

1. Enable the Python Editor Script Plugin (and Remote Control API for the live link).
2. Save the **Unreal** tab and run it: Tools, Execute Python Script. You should get `/Game/Inoscula/M_Claymation`.
3. Open it: the native expressions shown in Inoscula Studio's Nodes view (Unreal), wired to parameters and to
   the material inputs. If they will not build, try "One Custom node" in the Unreal tab, the simpler form. Check the Output Log for
   "Inoscula: built". If a compile error shows, copy it and send it over: that is exactly what needs fixing.
4. Import your `.inoscula.glb` with vertex colors kept (Import Vertex Color: Replace). Drag it into the level,
   select it and run the script again: the Output Log says "Inoscula: put MI_Claymation on 1 selected mesh" and
   the object wears the Material Instance (and the outline, for looks that have one). Move the sliders in it.
5. Try **Material Function** and **Substrate** in the export options (Substrate must be on in Project
   Settings, Rendering). Drag the function into one of your own materials.
6. **Round trip:** select the Material Instance, run `importers/inoscula_from_unreal.py`. It writes
   `Saved/Inoscula/<name>.inoscula.json`. Open it in Inoscula Studio, then send it to Blender.

## 4. Unity (URP, Unity 6, Windows or Mac)

1. Make a project with the **Universal 3D** template in Unity Hub.
2. In Inoscula Studio, open the **Unity** tab, keep **Shader file (drop in)** and press Save file (or use the
   `.shader` from `Convert A Shader.bat`). Drag it into Unity's Project window.
3. Right-click the shader, Create, Material. Drag the material onto your model. The sliders are on the
   material in the Inspector, and the look lights from the scene's Directional Light. Looks with an outline
   draw it from the same material.
4. Check that Edit, Project Settings, Player, Other Settings, Color Space is **Linear** (the default for new
   URP projects). Compare with Inoscula Studio set to **Preview as: Unity**.
5. Models with Inoscula's vertex colors (`.inoscula.glb`) need glTF support: Window, Package Manager, +, Add
   package by name, `com.unity.cloud.gltfast`. Other models work as FBX or OBJ.
6. **Shader Graph instead:** pick **Shader Graph file**, add a Custom Function node (Type File, Name as written
   at the top of the file) and wire the inputs it lists. Use this only if you want to keep building in a graph.

## 5. Live link

1. `node bin/inoscula-live.ts` (add `--unreal http://localhost:30010 --unreal-instance /Game/Inoscula/MI_Claymation`
   for Unreal).
2. Blender: install `importers/inoscula_live_blender.py` as an add-on. Godot: add `importers/inoscula_live.gd` to the
   scene. RICO: listen for OSC on port 9000.
3. Inoscula Studio: press the connection button at the top right (it says Offline), then Connect; it turns green. Move a slider: Blender, Godot, Unreal and RICO follow.
   Move a value in Blender: the Studio follows.

## 6. Render check

`node bin/inoscula-check.ts looks/claymation.inoscula --godot /path/to/godot --blender /path/to/blender --engine EEVEE`

Writes RICO, Blender and Godot renders of the same scene side by side in `check-out/`.

## 7. The full test suite

`THREE=node_modules/three/build/three.module.js GODOT=/path/to/godot node test/run.mjs`

It needs `glslangValidator` and `dxc` on PATH. `dxc` is Microsoft's HLSL compiler, the one Unreal 5 uses for
Shader Model 6. Get it from https://github.com/microsoft/DirectXShaderCompiler/releases. It is stricter than
glslang: it catches things like `float3(x)` that only glslang lets through. `node test/dxc.ts <folder>` runs that
check on its own. It covers the Unity file, the Unreal Custom node in each form, and every Custom node in the
native-node Unreal material.

## 8. Shaders from elsewhere (GLSL and HLSL)

`node test/glsl_compare.mjs <three.module.js> <folder>`

Every shader in `test/glsl` (Shadertoy, The Book of Shaders, GLSL Sandbox, three.js, TouchDesigner and code written
by hand) and `test/hlsl` (plain HLSL, Unity built-in and URP, an Unreal Custom node) is drawn
twice in the browser: once as the original, once as the nodes Inoscula made from it. It prints how many pixels
match. The HLSL originals are built with the DirectX compiler and SPIRV-Cross, the way the real programs build
them, so it also needs `dxc` and `spirv-cross` (set `DXC` and `SPIRV_CROSS` if they are not on PATH).
`test/hlsl_stubs` holds the few parts of Unity's include files those shaders use.

`test/run.mjs` runs this, then bakes the same shaders in Blender and draws them in Godot and compares those too.
Two of them (`shadertoy-fbm` and `shadertoy-voronoi`) make random numbers with `fract(sin(x) * 43758.5)`. Blender
rounds that differently, so their random pattern differs there, as the note in the reader says.
