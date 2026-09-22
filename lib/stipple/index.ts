import * as THREE from "three"
import { GPUComputationRenderer } from "three-stdlib"
import { velocityShader, positionShader, particleVertexShader, particleFragmentShader } from "./shaders"

export * from "./shaders"

export type StippleSource = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
export interface StippleOptions {
  density: number
  threshold: number
  attraction: number
  repulsion: number
  returnStrength: number
  radius: number
  friction: number
  inverted: boolean
  active: boolean
  mirror: boolean
}

export const defaultOptions: Readonly<StippleOptions> = Object.freeze({
  density: 1, threshold: 0.64, attraction: 1.58, repulsion: 0.75,
  returnStrength: 0.55, radius: 1, friction: 0.89,
  inverted: false, active: true, mirror: false,
})

const limits = {
  density: [0.25, 16], threshold: [0, 1], attraction: [0, 2],
  repulsion: [0, 1], returnStrength: [0, 1], radius: [1, 10], friction: [0, 1],
} as const

function normalize(options: StippleOptions): StippleOptions {
  const next = { ...options }
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const value = next[key]
    if (!Number.isFinite(value)) throw new TypeError(`${key} must be a finite number`)
    next[key] = THREE.MathUtils.clamp(value, limits[key][0], limits[key][1])
  }
  return next
}

/** GPU particle stippling. The caller owns the source media and the canvas CSS size. */
export function createStippleEffect({ canvas, source, ...initialOptions }: {
  canvas: HTMLCanvasElement
  source: StippleSource
} & Partial<StippleOptions>) {
  let options = normalize({ ...defaultOptions, ...initialOptions })
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false })
  if (!renderer.extensions.has("EXT_color_buffer_float")) {
    renderer.dispose()
    throw new Error("Stipple requires WebGL 2 with floating-point render targets")
  }
  renderer.setPixelRatio(1)
  renderer.setClearColor(0x000000, 1)
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
  camera.position.z = 1
  const texture = source instanceof HTMLVideoElement ? new THREE.VideoTexture(source) : new THREE.Texture(source)
  texture.minFilter = texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  let compute: GPUComputationRenderer
  let position: ReturnType<GPUComputationRenderer["addVariable"]>
  let velocity: ReturnType<GPUComputationRenderer["addVariable"]>
  let points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> | undefined
  let disposed = false
  let running = false
  let frame = 0
  let previousTime = 0
  let accumulator = 0
  let width = 1
  let height = 1

  function releaseSimulation() {
    compute?.dispose()
    position?.material.dispose()
    velocity?.material.dispose()
    if (points) {
      scene.remove(points)
      points.geometry.dispose()
      points.material.dispose()
      points = undefined
    }
  }

  function initialize() {
    releaseSimulation()
    const size = Math.round(128 * Math.sqrt(options.density))
    compute = new GPUComputationRenderer(size, size, renderer)
    compute.setDataType(THREE.HalfFloatType)
    const positions = compute.createTexture()
    const velocities = compute.createTexture()
    const data = positions.image.data as unknown as Float32Array
    const uvs = new Float32Array(size * size * 2)
    for (let i = 0; i < size * size; i++) {
      const x = ((i % size) + 0.5) / size
      const y = (Math.floor(i / size) + 0.5) / size
      data.set([x * 2 - 1, y * 2 - 1, x * 2 - 1, y * 2 - 1], i * 4)
      uvs.set([x, y], i * 2)
    }
    velocity = compute.addVariable("textureVelocity", velocityShader, velocities)
    position = compute.addVariable("texturePosition", positionShader, positions)
    compute.setVariableDependencies(velocity, [position, velocity])
    compute.setVariableDependencies(position, [position, velocity])
    velocity.material.uniforms = {
      videoTexture: { value: texture }, uThreshold: { value: options.threshold },
      uAttraction: { value: options.attraction }, uRepulsion: { value: options.repulsion },
      uReturnStrength: { value: options.returnStrength }, uFriction: { value: options.friction },
      uInverted: { value: Number(options.inverted) }, uActive: { value: Number(options.active) },
      uMirror: { value: Number(options.mirror) }, videoAspect: { value: 1 }, screenAspect: { value: 1 },
    }
    const error = compute.init()
    if (error) throw new Error(`Stipple requires GPU computation support: ${error}`)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(size * size * 3), 3))
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2))
    const material = new THREE.ShaderMaterial({
      uniforms: {
        texturePosition: { value: compute.getCurrentRenderTarget(position).texture },
        videoTexture: { value: texture }, uRadius: { value: options.radius },
        uMirror: { value: Number(options.mirror) }, videoAspect: { value: 1 }, screenAspect: { value: 1 },
      },
      vertexShader: particleVertexShader, fragmentShader: particleFragmentShader,
      depthTest: false, depthWrite: false,
    })
    points = new THREE.Points(geometry, material)
    points.frustumCulled = false
    scene.add(points)
  }

  function resize() {
    width = Math.max(1, canvas.clientWidth)
    height = Math.max(1, canvas.clientHeight)
    renderer.setSize(width, height, false)
  }

  function render(time: number) {
    if (!running || disposed || !points) return
    frame = requestAnimationFrame(render)
    if (document.hidden) { previousTime = 0; return }
    const sourceWidth = source instanceof HTMLVideoElement ? source.videoWidth : source instanceof HTMLImageElement ? source.naturalWidth : source.width
    const sourceHeight = source instanceof HTMLVideoElement ? source.videoHeight : source instanceof HTMLImageElement ? source.naturalHeight : source.height
    if (!sourceWidth || !sourceHeight || (source instanceof HTMLVideoElement && source.readyState < 2)) return
    if (source instanceof HTMLCanvasElement) texture.needsUpdate = true
    const uniforms = velocity.material.uniforms
    uniforms.uThreshold.value = options.threshold
    uniforms.uAttraction.value = options.attraction
    uniforms.uRepulsion.value = options.repulsion
    uniforms.uReturnStrength.value = options.returnStrength
    uniforms.uFriction.value = options.friction
    uniforms.uInverted.value = Number(options.inverted)
    uniforms.uActive.value = Number(options.active)
    for (const values of [uniforms, points.material.uniforms]) {
      values.videoAspect.value = sourceWidth / sourceHeight
      values.screenAspect.value = width / height
      values.uMirror.value = Number(options.mirror)
    }
    points.material.uniforms.uRadius.value = options.radius
    // Preserve the original 60 Hz simulation speed on high-refresh displays.
    accumulator += previousTime ? Math.min(time - previousTime, 50) : 1000 / 60
    previousTime = time
    while (accumulator >= 1000 / 60) {
      compute.compute()
      accumulator -= 1000 / 60
    }
    points.material.uniforms.texturePosition.value = compute.getCurrentRenderTarget(position).texture
    renderer.render(scene, camera)
  }

  function pause() {
    running = false
    cancelAnimationFrame(frame)
    previousTime = 0
    accumulator = 0
  }
  function resume() {
    if (disposed || running) return
    running = true
    frame = requestAnimationFrame(render)
  }
  const observer = new ResizeObserver(resize)
  try {
    initialize()
    resize()
    observer.observe(canvas)
    resume()
  } catch (error) {
    releaseSimulation()
    texture.dispose()
    renderer.dispose()
    observer.disconnect()
    throw error
  }

  return {
    /** Update live parameters. Density changes rebuild the particle grid. */
    update(next: Partial<StippleOptions>) {
      if (disposed) throw new Error("This stipple effect has been disposed")
      const normalized = normalize({ ...options, ...next })
      const rebuild = normalized.density !== options.density
      options = normalized
      if (rebuild) initialize()
    },
    pause,
    resume,
    /** Releases GPU resources and listeners. Does not stop caller-owned camera tracks. */
    dispose() {
      if (disposed) return
      pause()
      disposed = true
      observer.disconnect()
      releaseSimulation()
      texture.dispose()
      renderer.dispose()
    },
  }
}
