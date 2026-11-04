// Inoscula: write a realtime shader once, get native, editable versions for every engine.
export * from './spec.ts'
export { toThree } from './targets/three.ts'
export { toGodot, toGodotOutline, GODOT_LIGHT_BRIDGE } from './targets/godot.ts'
export { toUnreal, toUnity, toUnityOutline } from './targets/hlsl.ts'
export { toBlender } from './targets/blender.ts'
