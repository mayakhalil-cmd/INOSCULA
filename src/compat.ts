// What changes, if anything, when a shader goes to each tool. Shown in Inoscula Studio next to every export, so
// nobody has to find out in the target program.
import type { IR } from './spec.ts'

export type Target = 'blender' | 'godot' | 'unreal' | 'unity' | 'rico'
export interface Note { level: 'same' | 'close' | 'missing'; text: string }

export function compat(ir: IR, t: Target, o: { substrate?: boolean } = {}): Note[] {
  const n: Note[] = []
  const L = ir.layers
  if (!ir.lit) {
    n.push({ level: 'same', text: 'Unlit: the colour is computed the same way everywhere, to the pixel.' })
    const tm: Record<Target, string> = {
      blender: 'Blender shows it through its view transform (AgX by default). Set Color Management > View Transform to Standard for the exact colours.',
      unreal: 'Unreal passes unlit colour through its tonemapper. For exact colours, use a post process volume with the tonemapper set to neutral, or view in Unlit mode.',
      godot: 'Godot\'s default tonemap is Linear, so colours match as they are.',
      unity: 'Unity shows the colour as it is unless a post process volume adds tonemapping.',
      rico: 'RICO shows the colour as it is.',
    }
    n.push({ level: t === 'godot' || t === 'unity' || t === 'rico' ? 'same' : 'close', text: tm[t] })
  } else {
    n.push({ level: 'same', text: 'Base colour, roughness, metallic, bumps and emission are computed the same way everywhere.' })
    n.push({ level: 'close', text: 'Lighting is the tool\'s own, so expect the differences you would see between these renderers with any material.' })
    if (ir.bump && t === 'unreal') n.push({ level: 'same', text: 'Bumps come out as a world space normal; the material is set to accept one.' })
    if (L.coat) {
      if (t === 'unreal') n.push({ level: o.substrate ? 'close' : 'missing', text: o.substrate ? 'Coat becomes the Slab\'s second roughness lobe, a close match to a clear coat.' : 'Coat needs Substrate (tick it) or the Clear Coat shading model; Default Lit has no coat.' })
      if (t === 'unity') n.push({ level: 'close', text: 'Coat needs the Complex Lit material type in URP (Coat Mask, Coat Smoothness).' })
      if (t === 'godot' || t === 'blender' || t === 'rico') n.push({ level: 'same', text: 'Coat maps to the built-in clear coat.' })
    }
    if (L.sheen) {
      if (t === 'godot') n.push({ level: 'close', text: 'Godot has no sheen layer; its rim light stands in.' })
      if (t === 'unity') n.push({ level: 'missing', text: 'URP Lit has no sheen (HDRP\'s Fabric shader does).' })
      if (t === 'unreal') n.push({ level: o.substrate ? 'same' : 'missing', text: o.substrate ? 'Sheen becomes the Slab\'s fuzz.' : 'Sheen needs Substrate (fuzz) or the Cloth shading model.' })
      if (t === 'blender' || t === 'rico') n.push({ level: 'same', text: 'Sheen maps to the built-in sheen layer.' })
    }
    if (L.subsurface) {
      if (t === 'rico') n.push({ level: 'missing', text: 'The RICO and web preview has no subsurface scattering; the light will look harder than in Blender or Unreal.' })
      if (t === 'unity') n.push({ level: 'missing', text: 'URP Lit has no subsurface scattering (HDRP does).' })
      if (t === 'unreal') n.push({ level: o.substrate ? 'missing' : 'missing', text: 'Subsurface needs the Subsurface shading model or a Substrate SSS setup; it is not wired yet.' })
      if (t === 'blender' || t === 'godot') n.push({ level: 'close', text: 'Subsurface maps to the built-in subsurface scattering (Godot needs it on in Project Settings).' })
    }
  }
  if (ir.uses.has('curvature') || ir.uses.has('occlusion')) n.push({ level: 'close', text: 'Edge wear and grime read the shape data stored in the model. Use Prepare model, then import that model, or they read as flat and open.' })
  if (ir.source.cards) n.push({ level: 'close', text: t === 'blender' ? 'Made for brush cards: select the model and run importers/inoscula_cards_blender.py, or import the model with cards saved from Inoscula Studio.' : t === 'rico' ? 'Made for brush cards: look.addCards(mesh) lays them.' : 'Made for brush cards: import the model with cards saved from Inoscula Studio (Brush cards, then Save model), and give the cards this material too.' })
  if (ir.source.shells) n.push({ level: 'close', text: t === 'blender' ? 'Made for a rim and offset outlines: select the model and run importers/inoscula_shells_blender.py.' : t === 'rico' ? 'Made for a rim and offset outlines: look.addShells(mesh) adds them.' : 'Made for a rim and offset outlines: import the model saved from Inoscula Studio (Save model keeps them) and give them this material too.' })
  if (ir.cutout && t === 'unity') n.push({ level: 'close', text: 'Cutout: in Graph Settings turn on Alpha Clipping (threshold 0.5) and set Render Face to Both.' })
  if (ir.uses.has('time')) n.push({ level: 'same', text: t === 'blender' ? 'Time follows the timeline (frame / fps).' : t === 'unreal' ? 'Time follows Unreal\'s game time; use Sequencer on a parameter for scrubbable animation.' : 'Time follows the engine clock.' })
  if (ir.uses.has('light_dir')) n.push({ level: 'same', text: t === 'blender' ? 'Light direction follows a Sun called "RICO Sun" (or the first Sun).' : t === 'godot' ? 'Light direction: add inoscula_light_bridge.gd and point it at your DirectionalLight3D.' : t === 'rico' ? 'Light direction follows the scene\'s main light.' : 'Light direction is the "Inoscula Light Direction" parameter; drive it from your sun.' })
  return n
}
