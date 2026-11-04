// RICO Engine adapter. RICO renders with three.js, so a Inoscula graph becomes a live ShaderMaterial:
//   const look = inosculaMaterial(THREE, graph)
//   mesh.material = look.material
//   every frame: look.tick(seconds, sunLight)       // keeps time and the lighting contract live
//   look.set('tint', [1, 0.4, 0.2])                  // any parameter, e.g. from a MIDI or OSC route
// THREE is passed in so this file never bundles its own copy.
import { check, type Graph } from './spec.ts'
import { toThree, type ThreeOpts } from './targets/three.ts'
import { brushCards, meshArea, paintShells, smoothNormals, type CardOptions, type ShellOptions } from './cards.ts'

type V3 = [number, number, number]

export function inosculaMaterial(THREE: any, graph: Graph, opts: ThreeOpts & { transparent?: boolean } = {}) {
  const ir = check(graph)
  const sh = toThree(ir, opts)
  const uniforms: Record<string, { value: any }> = {}
  for (const [k, v] of Object.entries(sh.uniforms)) uniforms[k] = { value: Array.isArray(v) ? new THREE.Vector3(...v) : v }
  let material: any
  if (sh.lit) {
    // lit: three's own physical material does the lighting, shadows, environment and tonemapping
    material = new THREE.MeshPhysicalMaterial({ name: graph.name, transparent: opts.transparent ?? (Boolean(ir.alpha) && !ir.cutout), vertexColors: sh.vertexColors })
    if (ir.cutout) { material.alphaTest = 0.5; material.side = THREE.DoubleSide }
    material.defines = { USE_UV: '' }
    if (ir.layers.coat) material.clearcoat = 1 // turns three's coat layer on; the shader sets the amount
    if (ir.layers.sheen) material.sheen = 1
    material.onBeforeCompile = (s: any) => {
      Object.assign(s.uniforms, uniforms)
      const p = sh.litPatch!(s.vertexShader, s.fragmentShader)
      s.vertexShader = p.vertexShader
      s.fragmentShader = p.fragmentShader
    }
    const key = sh.fragmentShader
    material.customProgramCacheKey = () => key
  } else {
    material = new THREE.ShaderMaterial({
      name: graph.name,
      vertexShader: sh.vertexShader,
      fragmentShader: sh.fragmentShader,
      uniforms,
      vertexColors: sh.vertexColors,
      transparent: opts.transparent ?? (Boolean(ir.alpha) && !ir.cutout),
      side: ir.cutout ? THREE.DoubleSide : THREE.FrontSide,
      toneMapped: false, // unlit: the colour is shown exactly as the shader writes it
    })
  }
  // outline: a second, inside-out copy of each mesh pushed out along its normals, sharing the same parameters
  let outlineMaterial: any = null
  if (sh.outline) {
    const u: Record<string, { value: any }> = {}
    for (const [k, from] of Object.entries(sh.outline.uniforms)) u[k] = uniforms[from]
    outlineMaterial = new THREE.ShaderMaterial({ vertexShader: sh.outline.vertexShader, fragmentShader: sh.outline.fragmentShader, uniforms: u, side: THREE.BackSide, toneMapped: false })
  }
  const dir = new THREE.Vector3()
  return {
    material,
    outlineMaterial,
    /** Adds the outline to a mesh (or every mesh inside a group). Does nothing for shaders without one. */
    addOutline(obj: any) {
      if (!outlineMaterial) return
      const meshes: any[] = []
      obj.traverse?.((o: any) => { if (o.isMesh && !o.userData.inosculaOutline && !o.userData.inosculaCards) meshes.push(o) })
      for (const m of meshes) {
        // the outline shell inflates along smooth normals, so hard edges stay closed
        const g = m.geometry.clone()
        if (!g.attributes.normal) g.computeVertexNormals()
        g.setAttribute('normal', new THREE.BufferAttribute(smoothNormals(g.attributes.position.array, g.attributes.normal.array), 3))
        const o = new THREE.Mesh(g, outlineMaterial); o.userData.inosculaOutline = true; m.add(o)
      }
    },
    /** Tells the shader how big this object is (object_size), so a look keeps the same number of strokes on a
     *  pebble and on a building. Call once per object that uses the material, and again after resizing it. */
    fitTo(obj: any) {
      if (!uniforms.inoscula_object_size) return
      obj.updateMatrixWorld?.(true)
      const size = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3()).length() || 2
      obj.traverse?.((m: any) => {
        if (!m.isMesh || m.material !== material) return
        m.onBeforeRender = () => { uniforms.inoscula_object_size.value = size; material.uniformsNeedUpdate = true }
      })
    },
    /** Adds the outer rim and the offset outlines (copies of each mesh, drawn with this same material). Uses the
     *  look's own shell settings unless you pass others. Returns the shell meshes. */
    addShells(obj: any, o: ShellOptions = {}) {
      const meshes: any[] = [], made: any[] = []
      obj.traverse?.((m: any) => { if (m.isMesh && !m.userData.inosculaOutline && !m.userData.inosculaCards && !m.userData.inosculaShells) meshes.push(m) })
      for (const [mi, m] of meshes.entries()) {
        const g = m.geometry
        if (!g.attributes.normal) g.computeVertexNormals()
        const k = paintShells(g.attributes.position.array, g.attributes.normal.array, g.index ? g.index.array : null, { ...graph.shells, ...o, seed: (o.seed ?? 11) + mi })
        const cg = new THREE.BufferGeometry()
        cg.setAttribute('position', new THREE.BufferAttribute(k.positions, 3)); cg.setAttribute('normal', new THREE.BufferAttribute(k.normals, 3))
        cg.setAttribute('uv', new THREE.BufferAttribute(k.uvs, 2)); cg.setIndex(new THREE.BufferAttribute(k.indices, 1))
        const n = k.positions.length / 3, col = new Float32Array(n * 3).fill(0.5); for (let i = 1; i < col.length; i += 3) col[i] = 1
        cg.setAttribute('color', new THREE.BufferAttribute(col, 3))
        const c = new THREE.Mesh(cg, material); c.userData.inosculaShells = true; m.add(c); made.push(c)
      }
      return made
    },
    /** Lays brush cards over a mesh (or every mesh in a group), drawn with this material. Uses the look's own
     *  card settings unless you pass others. Returns the card meshes. */
    addCards(obj: any, o: CardOptions = {}) {
      const meshes: any[] = [], made: any[] = []
      obj.traverse?.((m: any) => { if (m.isMesh && !m.userData.inosculaOutline && !m.userData.inosculaCards) meshes.push(m) })
      // strokes shared between the parts by area, the same size in every part
      obj.updateMatrixWorld?.(true)
      const rootScale = obj.matrixWorld?.getMaxScaleOnAxis?.() ?? 1
      const scaleOf = (m: any) => (m.matrixWorld?.getMaxScaleOnAxis?.() ?? 1) / rootScale
      const areas = meshes.map((m) => meshArea(m.geometry.attributes.position.array, m.geometry.index ? m.geometry.index.array : null, scaleOf(m)))
      const total = areas.reduce((x, y) => x + y, 0) || 1
      const whole = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3()).length() / rootScale
      const base = { count: 2400, length: 0.07, width: 0.32, ...graph.cards, ...o }
      for (const [mi, m] of meshes.entries()) {
        const g = m.geometry
        if (!g.attributes.normal) g.computeVertexNormals()
        g.computeBoundingBox()
        const own = g.boundingBox.getSize(new THREE.Vector3()).length() * scaleOf(m) || 1
        const k = brushCards(g.attributes.position.array, g.attributes.normal.array, g.index ? g.index.array : null, { ...base, count: Math.max(1, Math.round(base.count * areas[mi] / total)), length: base.length * whole / own, seed: (base.seed ?? 7) + mi })
        const cg = new THREE.BufferGeometry()
        cg.setAttribute('position', new THREE.BufferAttribute(k.positions, 3)); cg.setAttribute('normal', new THREE.BufferAttribute(k.normals, 3))
        cg.setAttribute('uv', new THREE.BufferAttribute(k.uvs, 2)); cg.setIndex(new THREE.BufferAttribute(k.indices, 1))
        const c = new THREE.Mesh(cg, material); c.userData.inosculaCards = true; c.castShadow = m.castShadow; m.add(c); made.push(c)
      }
      return made
    },
    params: ir.params,
    /** Set a parameter by id. Numbers for float parameters, [x, y, z] or [r, g, b] (linear) for the rest. */
    set(id: string, v: number | V3) {
      const u = uniforms['p_' + id]
      if (!u) return false
      if (Array.isArray(v)) u.value.set(v[0], v[1], v[2])
      else u.value = v
      return true
    },
    /** Call once a frame. light: any three DirectionalLight; its direction and colour feed the lighting contract. */
    tick(seconds: number, light?: any) {
      uniforms.inoscula_time.value = seconds
      if (light) {
        light.updateMatrixWorld?.()
        dir.setFromMatrixPosition(light.matrixWorld)
        if (light.target) { light.target.updateMatrixWorld?.(); dir.sub(new THREE.Vector3().setFromMatrixPosition(light.target.matrixWorld)) }
        uniforms.inoscula_light_dir.value.copy(dir.normalize())
        uniforms.inoscula_light_color.value.set(light.color.r, light.color.g, light.color.b)
      }
    },
    dispose() { material.dispose() },
  }
}
