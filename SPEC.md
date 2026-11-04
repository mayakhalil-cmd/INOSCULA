# Inoscula format, version 0.1

A Inoscula shader is one JSON file. This document is the whole format: anyone may write a reader or a writer
for it, in any tool, under any licence.

## The file

```json
{
  "inoscula": "0.1",
  "name": "Ink Wash",
  "params": [
    { "id": "ink", "type": "color", "default": [0.08, 0.1, 0.22], "label": "Ink" },
    { "id": "scale", "type": "float", "default": 3.0, "min": 0.5, "max": 20, "label": "Grain Scale" }
  ],
  "nodes": [
    { "id": "p", "op": "object_pos" },
    { "id": "n", "op": "noise", "in": { "p": "p", "scale": "$scale" } },
    { "id": "c", "op": "mix", "in": { "a": "$ink", "b": [1, 1, 1], "t": "n" } }
  ],
  "output": { "color": "c", "alpha": 1 }
}
```

- **params**: the controls a person can change in every tool. `type` is `float`, `color` (linear RGB) or
  `vector`. `min` and `max` are slider hints.
- **nodes**: each has an `id`, an `op` from the table below, `in` (wires into its inputs) and sometimes `set`
  (settings that are not wires, such as ramp stops).
- **wires**: `"node"`, `"node.output"` (for nodes with several outputs, such as `separate`), `"$param"`, a
  number, or `[x, y, z]`. An input left out uses its default.
- **shading**: `"unlit"` (default) or `"lit"`.
- **output**: `color` (required) and `alpha` (optional, 0 to 1). Lit shaders also take `roughness`, `metallic`,
  `bump` (height in metres), `emission`, and the layers `coat`, `coat_roughness`, `sheen`, `sheen_color`,
  `sheen_roughness` and `subsurface`, named as in OpenPBR.

## Types

There are two: `float` and `vec3` (vectors and colours). A float wired into a vec3 input becomes (f, f, f), as
it does in every engine. A vec3 is never squashed into a float without asking: use `separate` or `dot`. This
rule exists because engines disagree about it (Blender averages, Unreal takes the first channel).

Generic nodes (inputs marked with no type below) work on floats or vec3s. If any of their inputs is a vec3,
the node works per component and outputs a vec3.

## Space

All positions and directions are in one shared space: Z up, right handed, metres, UV origin at the bottom
left. This is Blender's convention. Each target converts its own inputs into it with one line, so the same
graph means the same thing everywhere:

| Tool | Up | Hand | Units | Conversion into Inoscula space |
|---|---|---|---|---|
| Blender | Z | right | m | none |
| Godot, three.js, RICO | Y | right | m | (x, y, z) to (x, -z, y) |
| Unreal | Z | left | cm | (x, y, z) to (x, -y, z) / 100 (to be confirmed with a real import) |
| Unity | Y | left | m | (x, y, z) to (x, z, y) (to be confirmed with a real import) |

Meshes imported from glTF store UVs with the origin at the top left; the Godot and Unreal targets flip them
back by default.

## Nodes

| Node | Inputs | Output | Blender node | Notes |
|---|---|---|---|---|
| `uv` | none | vec3 | Texture Coordinate > UV | Mesh UV as (u, v, 0), origin bottom left. |
| `object_pos` | none | vec3 | Texture Coordinate > Object | Position in the object's own space. Moves with the object. |
| `world_pos` | none | vec3 | Geometry > Position | Position in world space, metres. |
| `normal` | none | vec3 | Geometry > Normal | World space surface normal. |
| `object_normal` | none | vec3 | Texture Coordinate > Normal | Object space surface normal. |
| `view_dir` | none | vec3 | Geometry > Incoming | World space direction from the surface towards the camera. |
| `time` | none | float | Value with a frame / fps driver | Seconds. |
| `light_dir` | none | vec3 | Group input, driven by the Sun | Lighting contract: world direction towards the main light. |
| `light_color` | none | vec3 | Group input, driven by the Sun | Lighting contract: main light colour. |
| `curvature` | none | float | Color Attribute (red), decoded | Shape data: 0.5 on flat areas, towards 1 on sharp outer edges, towards 0 in creases. Stored in the mesh (vertex colour red) by Inoscula Studio's Prepare model. |
| `occlusion` | none | float | Color Attribute (green), decoded | Shape data: 1 in the open, towards 0 in crevices and contact areas. Stored in the mesh (vertex colour green). |
| `param` | none | same as inputs | Group input | An exposed, editable parameter. set.id names it. |
| `value` | none | same as inputs | Value or Combine XYZ | A constant. set.v is a number or [x, y, z]. |
| `add` | a, b | same as inputs | Math / Vector Math: Add | a + b |
| `sub` | a, b | same as inputs | Subtract | a - b |
| `mul` | a, b | same as inputs | Multiply | a * b, per component. |
| `div` | a, b | same as inputs | Divide | a / b, and 0 wherever b is 0. |
| `pow` | a, b | same as inputs | Math: Power (per component for vectors) | a to the power b. A negative a with a fractional b gives 0. |
| `min` | a, b | same as inputs | Minimum |  |
| `max` | a, b | same as inputs | Maximum |  |
| `clamp` | x, lo, hi | same as inputs | Clamp, or Maximum then Minimum for vectors |  |
| `abs` | x | same as inputs | Absolute |  |
| `floor` | x | same as inputs | Floor |  |
| `fract` | x | same as inputs | Fract / Fraction | x - floor(x) |
| `sin` | x | same as inputs | Sine | Radians. |
| `cos` | x | same as inputs | Cosine | Radians. |
| `one_minus` | x | same as inputs | Subtract from 1 | 1 - x |
| `exp` | x | same as inputs | Math: Exponent (per component for vectors) | e to the power x. |
| `sqrt` | x | same as inputs | Math: Square Root (per component for vectors) | Square root. Negative numbers give 0. |
| `mix` | a, b, t (float) | same as inputs | Mix (factor clamped) | Blend a to b. t is clamped to 0..1. |
| `smoothstep` | e0 (float), e1 (float), x (float) | float | Map Range, Smooth Step |  |
| `greater` | a (float), b (float) | float | Math: Greater Than | 1 if a > b, else 0. |
| `atan2` | y (float), x (float) | float | Math: Arctan2 | Angle of (x, y) in radians, -pi to pi. |
| `dot` | a (vec3), b (vec3) | float | Vector Math: Dot Product |  |
| `length` | x (vec3) | float | Vector Math: Length |  |
| `normalize` | x (vec3) | vec3 | Vector Math: Normalize | Zero stays zero. |
| `combine` | x (float), y (float), z (float) | vec3 | Combine XYZ |  |
| `separate` | v (vec3) | x: float, y: float, z: float | Separate XYZ |  |
| `noise` | p (vec3), scale (float), detail (float), roughness (float), lacunarity (float) | float | Noise Texture (3D, fBM, normalised, no distortion) | Gradient noise, fractal, 0..1. Bit-for-bit the same maths as Blender's Noise Texture (3D, fBM, normalised). |
| `white_noise` | p (vec3) | float | White Noise Texture (3D) > Value | A random number 0..1 for each exact point. Use floor() first for cells, flicker or grain that holds still. Same hash as Blender's White Noise Texture. |
| `voronoi` | p (vec3), scale (float), randomness (float) | float, color: vec3, position: vec3 | Voronoi Texture (3D, F1, Euclidean) | Cells. Main output: distance to the nearest cell point (F1, Euclidean). .color: a random colour per cell. .position: the cell point. Same maths as Blender's Voronoi Texture (3D, F1, Euclidean). |
| `ramp` | t (float) | vec3 | Color Ramp (Linear or Constant) | Colour ramp. set.mode is "linear" or "constant", set.stops is [[position, [r, g, b]], ...]. |

## Inoscula code

The same graph can be written as text that reads like GLSL. See `looks/` for full examples.

```
name "Ink Wash";
uniform vec3 paper = vec3(0.93, 0.89, 0.80);  // @color @label Paper
uniform float scale = 3.0;                      // @range 0.5 20 @label Grain Scale
void main() {
  float n = noise(object_pos, scale, 4.5, 0.55, 2.0);
  color = mix(vec3(0.08, 0.1, 0.22), paper, n);
}
```

- `shading "lit";` makes it a lit material; setting `roughness`, `metallic`, `bump`, `emission` or a layer does too.
- `surface "cutout";` cuts alpha at 0.5 and draws both sides (graph field `"surface": "cutout"`): an Alpha
  Scissor in Godot, a Masked two-sided material in Unreal, a Greater Than node on the alpha in Blender.
- `outline_rings = 3.0;` turns the outline into that many thin, loose lines floating around the shape at
  different offsets (0 to 4, a fixed number).
- `cards 3500, 0.06, 0.34;` says the look is made for brush cards: how many strokes, their length as a fraction
  of the model's size, and their width as a fraction of their length (graph field `"cards"`).
- Your own functions: `float bands(float x, float n) { ...; return ...; }`. They are copied in where used, so they
  still become plain nodes; a function cannot call itself.
- `uniform` lines are parameters. Comments on the same line set `@color`, `@range lo hi` and `@label Name`.
- Inputs: `uv object_pos object_normal world_pos normal view_dir time light_dir light_color curvature occlusion
  object_size`, plus `PI` and `TAU`. `object_size` is the diagonal of the object's bounding box in metres (2.0
  where a tool cannot tell).
- Functions are the nodes above by name, plus `atan(y, x)`, `hash(p)` (white noise), `step`, `saturate`, `mod`,
  `sign`, `reflect`, `distance` and `radians`, which become a few plain nodes each.
- `a > b`, `a < b`, `a >= b`, `a <= b` give 1.0 or 0.0; `c ? a : b` picks with a Mix node.
- `.x .y .z` (or `.r .g .b`) read one part of a vector.
- No loops and no if blocks, because node graphs cannot loop.
- Errors name the line and say how to fix it.

## How exact is each target?

Inoscula promises the same maths, not "something similar". Each node is placed at one of four levels:

1. **Native**: the tool has a node or function that does exactly this.
2. **Expanded**: rebuilt from the tool's basic nodes. Still fully editable. (Blender vector `pow`, vector
   `clamp`.)
3. **Code**: written as shader code inside the tool's own code node or shader file. (Godot, Unreal, Unity,
   three.js.)
4. **Near**: close, with a measured difference, shown in the test results. None in version 0.1.

Rules that make it exact:

- `div` returns 0 when dividing by 0, and `pow` returns 0 for a negative base with a fractional exponent,
  matching Blender's safe maths in every target.
- `mix` clamps its factor to 0..1.
- `greater` is strictly greater, like Blender's Greater Than.
- `ramp` reproduces Blender's 257 entry table (Constant reads one step, Linear blends two), so band edges land
  on the same pixels as in Blender.
- `noise` is Blender's Perlin noise and fractal sum, ported with its integer hash.

## The lighting contract

`light_dir` (world direction towards the main light) and `light_color` are inputs every target must provide.
Each target ships a bridge that keeps them following the scene's main light. This is what lets light-reactive,
stylised shading travel between tools without relying on any one renderer's lighting.

## Lit shading

In a lit shader `color` is the base colour of a physically based material, and each tool lights it with its own
renderer:

| Output | Blender | Unreal | Godot | Unity URP | RICO / three.js |
|---|---|---|---|---|---|
| color, roughness, metallic, emission | Principled BSDF | Default Lit or Substrate Slab (albedo and F0 derived) | ALBEDO, ROUGHNESS, METALLIC, EMISSION | Base Color, Smoothness, Metallic, Emission | MeshPhysicalMaterial |
| bump | Bump node | world space normal from screen derivatives | NORMAL from screen derivatives | NormalWS (World fragment normal space) | perturbed normal |
| coat | Coat Weight, Coat Roughness | Substrate second roughness lobe | CLEARCOAT | Coat Mask (Complex Lit) | clearcoat |
| sheen | Sheen Weight, Tint, Roughness | Substrate fuzz | rim light (closest) | none in URP | sheen |
| subsurface | Subsurface Weight | not wired yet | SSS_STRENGTH | none in URP | none |

## Shape data

`curvature` and `occlusion` come from the mesh's vertex colour: red is curvature (0.5 flat, 1 sharp edge, 0
crease), green is occlusion (1 open, 0 enclosed), and blue 0.5 marks the data as Inoscula's. A mesh without it
(white in Godot, Unreal and Unity, black in Blender) reads as flat and open in every tool. Inoscula Studio's
Prepare model writes it, and Save model exports it in a .glb.

## Brush cards

Brush cards are single strokes laid over a model as small curved strips, lifted just off the surface (see
`src/cards.ts`, `importers/inoscula_cards_blender.py`). Each card's UV carries its stroke: u runs from 100 + k to
101 + k along the stroke, where the whole number k (0 to 63) is the card's own random number, and v runs across
it from 0 to 1. A model's own UVs stay below 100, so one shader tells cards from the body with `uv.x > 99.5`.
Card normals are the surface normal under the card's middle, so each stroke is lit as one flat plane. Cards
carry neutral shape data (open, not on an edge).

## Round trips

Every export carries its graph: a `inoscula_graph` property on the Blender node group, a `// inoscula-graph:` line
in Godot and Unity files, and a `inoscula` metadata tag on the Unreal asset. The importers read the graph back
together with the parameter values set in that tool.

## Versioning

Readers must refuse a `inoscula` version they do not know, and say so. New nodes are added in minor versions; the
meaning of an existing node never changes.
