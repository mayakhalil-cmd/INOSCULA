# Testing Inoscula in each program

Do these once on your own machine. Each step says what you should see, so anything off is easy to spot and
report. Start with one stylised look (Paint Bands) and one lit look (Claymation).

## 0. Inoscula Studio

1. Open `dist/inoscula-studio.html` in Chrome, Firefox or Safari.
2. Pick **Claymation**, then **Load model** and choose any .glb of yours. Press **Prepare model**: edges
   chip and crevices darken. Press **Save model** to get `<name>.inoscula.glb`.
3. Switch **Looks like** between RICO, Blender, Unreal, Godot and Unity: the tonemapping changes, the material
   does not.
4. Switch to **Nodes** and double-click a node: the code view jumps to that line.

## 1. Blender (4.2 or later)

1. In Inoscula Studio, open the **Blender** tab and press Save file (or Copy and paste into a new text block).
2. Blender: Scripting workspace, Text Editor, open the file, Run Script.
3. You should see the material "Claymation" and the node group "Inoscula Claymation", with all the sliders on
   the group node. Assign it to your `.inoscula.glb` model (File, Import, glTF).
4. Add a Sun light and rename it "RICO Sun": shaders that use the light direction follow it.
5. Render in Eevee and Cycles. Compare with Inoscula Studio set to **Looks like: Blender**.
6. **Round trip:** change some group values and a node or two, select the object, run
   `importers/blender_to_inoscula.py`. Paste the `.inoscula.json` it writes into Inoscula Studio (Import graph). Your
   changes are in the code.

## 2. Godot (4.4 or later)

1. Save the **Godot** tab (VisualShader nodes) as `claymation.tres` in your project, or pick Shader code and save
   `claymation.gdshader`. New ShaderMaterial, set Shader to it.
2. Import your `.inoscula.glb` and assign the material. Parameters appear in the Inspector.
3. Add `inoscula_light_bridge.gd` to any node, point it at your DirectionalLight3D.
4. Compare with Inoscula Studio set to **Looks like: Godot**, or run the Render check (section 6).
5. **Round trip:** change values in the Inspector, save the material as .tres, then
   `node bin/inoscula-pull.ts claymation.tres claymation.gdshader`.

## 3. Unreal (5.4 or later)

This is the least tested target, so check it carefully.

1. Enable the Python Editor Script Plugin (and Remote Control API for the live link).
2. Save the **Unreal** tab and run it: Tools, Execute Python Script. You should get `/Game/Inoscula/M_Claymation`.
3. Open it: the native expressions shown in Inoscula Studio's Nodes view (Unreal), wired to parameters and to
   the material inputs. If they will not build, try "One Custom node" in the Unreal tab, the simpler form. Check the Output Log for
   "Inoscula: built". If a compile error shows, copy it and send it over: that is exactly what needs fixing.
4. Import your `.inoscula.glb` with vertex colours kept (Import Vertex Color: Replace). Make a Material Instance
   and move the sliders.
5. Try **Material Function** and **Substrate** in the export options (Substrate must be on in Project
   Settings, Rendering). Drag the function into one of your own materials.
6. **Round trip:** select the Material Instance, run `importers/inoscula_from_unreal.py`. It writes
   `Saved/Inoscula/<name>.inoscula.json`. Open it in Inoscula Studio, then send it to Blender.

## 4. Unity (URP, Shader Graph)

1. Save the **Unity** tab as a .hlsl file in Assets.
2. New Shader Graph (Lit for realistic looks, Unlit for stylised). Add a Custom Function node, Type File, pick
   the file, Name as written at the top of the file. Add the inputs and outputs it lists, wire them to Position,
   Normal Vector, Vertex Color and the master stack.
3. For bumps, set Graph Settings, Fragment Normal Space to World.

## 5. Live link

1. `node bin/inoscula-live.ts` (add `--unreal http://localhost:30010 --unreal-instance /Game/Inoscula/MI_Claymation`
   for Unreal).
2. Blender: install `importers/inoscula_live_blender.py` as an add-on. Godot: add `importers/inoscula_live.gd` to the
   scene. RICO: listen for OSC on port 9000.
3. Inoscula Studio: press **Live link** (it turns green). Move a slider: Blender, Godot, Unreal and RICO follow.
   Move a value in Blender: the Studio follows.

## 6. Render check

`node bin/inoscula-check.ts looks/claymation.inoscula --godot /path/to/godot --blender /path/to/blender --engine EEVEE`

Writes RICO, Blender and Godot renders of the same scene side by side in `check-out/`.

## 7. The full test suite

`THREE=node_modules/three/build/three.module.js GODOT=/path/to/godot node test/run.mjs`
