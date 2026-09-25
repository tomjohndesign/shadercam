"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { NativeCameraStatus, useNativeCamera } from "./native-camera"
import * as THREE from "three"
import { GPUComputationRenderer } from "three-stdlib"
import { FloatingPanel, Slider, Toggle, SegmentedControl, SelectControl, Button, Folder } from "./floating-panel"

// Types for MediaPipe
type HandLandmarkerType = {
  detectForVideo: (
    video: HTMLVideoElement,
    timestamp: number,
  ) => {
    landmarks: Array<Array<{ x: number; y: number; z: number }>>
    handedness: Array<{ categoryName: string }[]>
  }
  close: () => void
}

interface StipplingCanvasProps {
  /** Dot-count multiplier, from 0.25 to 16. Defaults to 1 (16,384 dots). */
  density?: number
}

function clampDensity(density: number) {
  return Number.isFinite(density) ? Math.max(0.25, Math.min(16, density)) : 1
}

export default function StipplingCanvas({ density = 1 }: StipplingCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const handOverlayRef = useRef<HTMLCanvasElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  // State
  const [error, setError] = useState<string | null>(null)
  const [isWebcamActive, setIsWebcamActive] = useState(true)
  const [isPlaying, setIsPlaying] = useState(false)
  const [handLandmarker, setHandLandmarker] = useState<HandLandmarkerType | null>(null)

  const nativeCamera = useNativeCamera(isPlaying && isWebcamActive)
  const publishFrame = nativeCamera.publish

  // A fixed 720p canvas gives meeting capture a stable aspect ratio and GPU cost.
  const outputWidth = 1280
  const outputHeight = 720

  // Device selection
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([])
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedVideoDeviceId, setSelectedVideoDeviceId] = useState<string>("")
  const [selectedAudioDeviceId, setSelectedAudioDeviceId] = useState<string>("")

  // Control mode
  const [controlMode, setControlMode] = useState<"sliders" | "hands">("sliders")

  // Parameters - default property set
  const [densityValue, setDensityValue] = useState(() => clampDensity(density))
  const particleCountBase = Math.round(128 * Math.sqrt(densityValue))
  const particleCount = particleCountBase * particleCountBase

  useEffect(() => {
    setDensityValue(clampDensity(density))
  }, [density])
  const [threshold, setThreshold] = useState(0.64)
  const [attraction, setAttraction] = useState(1.58)
  const [repulsion, setRepulsion] = useState(0.75)
  const [returnStrength, setReturnStrength] = useState(0.55)
  const [radius, setRadius] = useState(1)
  const [friction, setFriction] = useState(0.89)
  const [inverted, setInverted] = useState(false)
  const [isSimulationActive, setIsSimulationActive] = useState(true)
  const [isLocked, setIsLocked] = useState(false)

  // Store previous values for snap restore
  const prevValuesRef = useRef({
    threshold: 1.0,
    attraction: 1.0,
    repulsion: 0.0,
    returnStrength: 0.2,
    radius: 5.5,
    friction: 0.12,
  })

  // Refs for animation loop - stores all parameters that need to be accessed in the animation loop
  const paramsRef = useRef({
    threshold,
    attraction,
    repulsion,
    returnStrength,
    radius,
    friction,
    inverted,
    isSimulationActive,
  })

  // Update refs when state changes
  useEffect(() => {
    paramsRef.current = {
      threshold,
      attraction,
      repulsion,
      returnStrength,
      radius,
      friction,
      inverted,
      isSimulationActive,
    }
  }, [threshold, attraction, repulsion, returnStrength, radius, friction, inverted, isSimulationActive])

  // Enumerate devices. Until permission is granted browsers hide the real ids, returning
  // either an empty list or placeholder entries with a blank deviceId, so anything blank is
  // dropped here and the list is refreshed again once the webcam stream is live.
  const refreshDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      setVideoDevices(devices.filter((d) => d.kind === "videoinput" && d.deviceId && !/shadercam|stipple cam/i.test(d.label)))
      setAudioDevices(devices.filter((d) => d.kind === "audioinput" && d.deviceId))
    } catch (err) {
      console.error("Error enumerating devices:", err)
    }
  }, [])

  useEffect(() => {
    refreshDevices()
    navigator.mediaDevices?.addEventListener("devicechange", refreshDevices)
    return () => navigator.mediaDevices?.removeEventListener("devicechange", refreshDevices)
  }, [refreshDevices])

  // Initialize HandLandmarker when hands mode is selected
  useEffect(() => {
    if (controlMode !== "hands") return

    let cancelled = false
    const initHandLandmarker = async () => {
      try {
        const visionModule = await import("@mediapipe/tasks-vision")
        if (cancelled) return

        const { FilesetResolver, HandLandmarker } = visionModule

        const vision = await FilesetResolver.forVisionTasks(
          window.shaderCam ? "/mediapipe/wasm" : "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm",
        )
        if (cancelled) return

        const landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: window.shaderCam ? "/mediapipe/hand_landmarker.task" : "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numHands: 2,
        })
        if (!cancelled) {
          setHandLandmarker(landmarker as unknown as HandLandmarkerType)
        }
      } catch (err) {
        if (!cancelled) {
          console.error("Error initializing hand landmarker:", err)
        }
      }
    }
    initHandLandmarker()

    return () => {
      cancelled = true
    }
  }, [controlMode])

  // Track current values in a ref so snap detection can access them without re-running the effect
  const currentValuesRef = useRef({ threshold, attraction, repulsion, returnStrength, radius, friction })
  useEffect(() => {
    currentValuesRef.current = { threshold, attraction, repulsion, returnStrength, radius, friction }
  }, [threshold, attraction, repulsion, returnStrength, radius, friction])

  // Audio snap detection - ONLY when hands mode is active AND video is playing
  useEffect(() => {
    if (controlMode !== "hands" || !isPlaying) return

    let cancelled = false
    let audioStream: MediaStream | null = null
    let audioContext: AudioContext | null = null
    let analyser: AnalyserNode | null = null
    let dataArray: Uint8Array<ArrayBuffer> | null = null
    let rafId: number
    let lastSnapTime = 0

    const initAudio = async () => {
      try {
        const constraints: MediaStreamConstraints = {
          audio: selectedAudioDeviceId ? { deviceId: { exact: selectedAudioDeviceId } } : true,
        }
        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        if (cancelled) { stream.getTracks().forEach(track => track.stop()); return }
        audioStream = stream
        audioContext = new AudioContext()
        const source = audioContext.createMediaStreamSource(stream)
        analyser = audioContext.createAnalyser()
        analyser.fftSize = 256
        source.connect(analyser)
        dataArray = new Uint8Array(analyser.frequencyBinCount)

        const detectSnap = () => {
          if (!analyser || !dataArray) return
          analyser.getByteFrequencyData(dataArray)

          // Check for sudden loud sound (snap/clap)
          const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length
          const now = Date.now()

          if (average > 100 && now - lastSnapTime > 1000) {
            lastSnapTime = now
            // Toggle lock state
            setIsLocked((prev) => {
              if (!prev) {
                // Lock to preset values - read current values from ref
                prevValuesRef.current = { ...currentValuesRef.current }
                setThreshold(0.32)
                setAttraction(0.2)
                setRepulsion(0.55)
                setReturnStrength(0.01)
                setRadius(5.5)
                setFriction(0.13)
              } else {
                // Restore previous values
                setThreshold(prevValuesRef.current.threshold)
                setAttraction(prevValuesRef.current.attraction)
                setRepulsion(prevValuesRef.current.repulsion)
                setReturnStrength(prevValuesRef.current.returnStrength)
                setRadius(prevValuesRef.current.radius)
                setFriction(prevValuesRef.current.friction)
              }
              return !prev
            })
          }

          rafId = requestAnimationFrame(detectSnap)
        }
        detectSnap()
      } catch (err) {
        console.error("Error initializing audio:", err)
      }
    }

    initAudio()

    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
      audioStream?.getTracks().forEach(track => track.stop())
      audioContext?.close()
    }
  }, [controlMode, selectedAudioDeviceId, isPlaying])

  // Own each stream for the lifetime of this effect, including permission races.
  useEffect(() => {
    if (!isWebcamActive) return
    let cancelled = false
    let stream: MediaStream | null = null
    const video = videoRef.current
    const startWebcam = async () => {
      setError(null)
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access requires HTTPS or localhost.")
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            ...(selectedVideoDeviceId ? { deviceId: { exact: selectedVideoDeviceId } } : {}),
            width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 },
          },
        })
        // A virtual camera can become the OS default. Never feed our own output back in.
        if (/shadercam|stipple cam/i.test(stream.getVideoTracks()[0]?.label || "")) {
          stream.getTracks().forEach(track => track.stop())
          const devices = await navigator.mediaDevices.enumerateDevices()
          const input = devices.find(device => device.kind === "videoinput" && device.deviceId && !/shadercam|stipple cam/i.test(device.label))
          if (!input) throw new Error("No physical camera is available.")
          stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
            deviceId: { exact: input.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 },
          } })
        }
        if (cancelled || !video) { stream.getTracks().forEach(track => track.stop()); return }
        const ready = new Promise<void>(resolve => { video.onloadedmetadata = () => resolve() })
        video.srcObject = stream
        await ready
        if (cancelled) return
        await video.play()
        if (cancelled) return
        setIsPlaying(true)
        stream.getVideoTracks()[0]?.addEventListener("ended", () => {
          if (!cancelled) {
            setError("Camera disconnected. Reconnect it and start the camera again.")
            setIsWebcamActive(false)
            setIsPlaying(false)
          }
        })
        await refreshDevices()
      } catch (err) {
        if (!cancelled) {
          console.error("Error accessing webcam:", err)
          setError("Could not access camera. Check camera permissions or choose another camera, then retry.")
          setIsWebcamActive(false)
          setIsPlaying(false)
        }
      }
    }
    startWebcam()
    return () => {
      cancelled = true
      stream?.getTracks().forEach(track => track.stop())
      if (video) { video.onloadedmetadata = null; video.srcObject = null }
    }
  }, [selectedVideoDeviceId, isWebcamActive, refreshDevices])

  // Main Three.js / GPGPU effect
  useEffect(() => {
    if (!containerRef.current || !canvasRef.current || !videoRef.current || !isPlaying) return

    const container = containerRef.current
    const canvas = canvasRef.current
    const video = videoRef.current

    let animationId: number
    let renderer: THREE.WebGLRenderer
    let gpuCompute: GPUComputationRenderer
    let positionVariable: ReturnType<GPUComputationRenderer["addVariable"]>
    let velocityVariable: ReturnType<GPUComputationRenderer["addVariable"]>
    let particleMesh: THREE.Points
    let videoTexture: THREE.VideoTexture
    let scene: THREE.Scene
    let camera: THREE.OrthographicCamera

    // The simulation uses one texture texel per dot in a square grid.
    const particleCount = particleCountBase * particleCountBase
    const textureSize = particleCountBase

    const init = () => {
      // Renderer - use pixel ratio of 1 to avoid doubled particles on retina displays
      renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false })
      renderer.setSize(outputWidth, outputHeight, false)
      renderer.setPixelRatio(1)
      renderer.setClearColor(0x000000, 1)

      // Scene
      scene = new THREE.Scene()

      // Camera
      camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
      camera.position.z = 1

      // Video texture
      videoTexture = new THREE.VideoTexture(video)
      videoTexture.minFilter = THREE.LinearFilter
      videoTexture.magFilter = THREE.LinearFilter

      // GPGPU
      gpuCompute = new GPUComputationRenderer(textureSize, textureSize, renderer)

      // Position texture (xy = position, zw = home position)
      const positionTexture = gpuCompute.createTexture()
      // createTexture() allocates Float32Array data, which the Three.js image types omit.
      const posData = positionTexture.image.data as unknown as Float32Array
      for (let i = 0; i < particleCount; i++) {
        const ix = i % textureSize
        const iy = Math.floor(i / textureSize)
        const x = (ix / textureSize) * 2 - 1
        const y = (iy / textureSize) * 2 - 1
        posData[i * 4 + 0] = x
        posData[i * 4 + 1] = y
        posData[i * 4 + 2] = x // home x
        posData[i * 4 + 3] = y // home y
      }

      // Velocity texture
      const velocityTexture = gpuCompute.createTexture()
      const velData = velocityTexture.image.data as unknown as Float32Array
      for (let i = 0; i < particleCount * 4; i++) {
        velData[i] = 0
      }

      // Shaders - GPUComputationRenderer auto-injects: texturePosition, textureVelocity, resolution
      // DO NOT declare these uniforms manually or set resolution uniform
      const velocityShader = `
        uniform sampler2D videoTexture;
        uniform float uThreshold;
        uniform float uAttraction;
        uniform float uRepulsion;
        uniform float uReturnStrength;
        uniform float uFriction;
        uniform float uInverted;
        uniform float uActive;
        uniform float videoAspect;
        uniform float screenAspect;

        void main() {
          vec2 uv = gl_FragCoord.xy / resolution;
          vec4 posData = texture2D(texturePosition, uv);
          vec4 velData = texture2D(textureVelocity, uv);
          
          vec2 pos = posData.xy;
          vec2 home = posData.zw;
          vec2 vel = velData.xy;

          if (uActive < 0.5) {
            // Simulation paused - strong return to home
            vec2 toHome = home - pos;
            vel += toHome * 0.5;
            vel *= 0.8;
          } else {
            // Sample video with aspect ratio correction (cover mode)
            vec2 videoUV = pos * 0.5 + 0.5;
            videoUV.x = 1.0 - videoUV.x; // Mirror
            
            // Apply cover scaling
            float coverScale = max(screenAspect / videoAspect, 1.0);
            if (screenAspect < videoAspect) {
              coverScale = max(videoAspect / screenAspect, 1.0);
            }
            videoUV = (videoUV - 0.5) / coverScale + 0.5;
            
            vec4 videoColor = texture2D(videoTexture, videoUV);
            float brightness = dot(videoColor.rgb, vec3(0.299, 0.587, 0.114));
            
            // Invert if needed
            if (uInverted > 0.5) {
              brightness = 1.0 - brightness;
            }
            
            // Attraction to dark areas (below threshold)
            float attractionFactor = smoothstep(uThreshold, uThreshold - 0.3, brightness);
            
            // Sample neighbors for local density
            float repulsionForce = 0.0;
            vec2 repulsionDir = vec2(0.0);
            float sampleRadius = 2.0 / resolution.x;
            
            for (int i = 0; i < 8; i++) {
              float angle = float(i) * 0.785398;
              vec2 offset = vec2(cos(angle), sin(angle)) * sampleRadius;
              vec4 neighborPos = texture2D(texturePosition, uv + offset);
              vec2 diff = pos - neighborPos.xy;
              float dist = length(diff);
              if (dist > 0.001 && dist < 0.1) {
                repulsionDir += normalize(diff) / (dist + 0.01);
                repulsionForce += 1.0;
              }
            }
            
            if (repulsionForce > 0.0) {
              repulsionDir /= repulsionForce;
            }
            
            // Apply forces
            vel += repulsionDir * uRepulsion * 0.001;
            
            // Attraction pulls toward darker areas (move toward gradient)
            vec2 gradientDir = vec2(0.0);
            float eps = 0.01;
            float bRight = dot(texture2D(videoTexture, videoUV + vec2(eps, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
            float bLeft = dot(texture2D(videoTexture, videoUV - vec2(eps, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
            float bUp = dot(texture2D(videoTexture, videoUV + vec2(0.0, eps)).rgb, vec3(0.299, 0.587, 0.114));
            float bDown = dot(texture2D(videoTexture, videoUV - vec2(0.0, eps)).rgb, vec3(0.299, 0.587, 0.114));
            
            if (uInverted > 0.5) {
              bRight = 1.0 - bRight;
              bLeft = 1.0 - bLeft;
              bUp = 1.0 - bUp;
              bDown = 1.0 - bDown;
            }
            
            gradientDir.x = bLeft - bRight;
            gradientDir.y = bDown - bUp;
            
            vel += gradientDir * uAttraction * attractionFactor * 0.08;
            
            // Return to home
            vec2 toHome = home - pos;
            vel += toHome * uReturnStrength;
            
            // Friction
            vel *= (1.0 - uFriction);
            
            // Sleep threshold to reduce jitter
            if (length(vel) < 0.0001) {
              vel *= 0.5;
            }
            
            // Clamp velocity
            float maxSpeed = 0.02;
            if (length(vel) > maxSpeed) {
              vel = normalize(vel) * maxSpeed;
            }
          }

          gl_FragColor = vec4(vel, 0.0, 1.0);
        }
      `

      // Note: texturePosition, textureVelocity, and resolution are auto-injected by GPUComputationRenderer
      const positionShader = `
        void main() {
          vec2 uv = gl_FragCoord.xy / resolution;
          vec4 posData = texture2D(texturePosition, uv);
          vec4 velData = texture2D(textureVelocity, uv);
          
          vec2 pos = posData.xy + velData.xy;
          
          // Clamp to bounds
          pos = clamp(pos, vec2(-1.0), vec2(1.0));

          gl_FragColor = vec4(pos, posData.zw);
        }
      `

      velocityVariable = gpuCompute.addVariable("textureVelocity", velocityShader, velocityTexture)
      positionVariable = gpuCompute.addVariable("texturePosition", positionShader, positionTexture)

      gpuCompute.setVariableDependencies(velocityVariable, [positionVariable, velocityVariable])
      gpuCompute.setVariableDependencies(positionVariable, [positionVariable, velocityVariable])

      // Uniforms
      velocityVariable.material.uniforms.videoTexture = { value: videoTexture }
      velocityVariable.material.uniforms.uThreshold = { value: threshold }
      velocityVariable.material.uniforms.uAttraction = { value: attraction }
      velocityVariable.material.uniforms.uRepulsion = { value: repulsion }
      velocityVariable.material.uniforms.uReturnStrength = { value: returnStrength }
      velocityVariable.material.uniforms.uFriction = { value: friction }
      velocityVariable.material.uniforms.uInverted = { value: inverted ? 1.0 : 0.0 }
      velocityVariable.material.uniforms.uActive = { value: isSimulationActive ? 1.0 : 0.0 }
      // resolution is auto-injected by GPUComputationRenderer - don't override it
      velocityVariable.material.uniforms.videoAspect = { value: 16 / 9 }
      velocityVariable.material.uniforms.screenAspect = { value: outputWidth / outputHeight }

      // resolution is auto-injected by GPUComputationRenderer - don't override it

      const error = gpuCompute.init()
      if (error !== null) {
        console.error("GPGPU error:", error)
        setError("Failed to initialize GPU computation")
        return false
      }

      // Particle geometry
      const geometry = new THREE.BufferGeometry()
      const positions = new Float32Array(particleCount * 3)
      const uvs = new Float32Array(particleCount * 2)

      for (let i = 0; i < particleCount; i++) {
        const ix = i % textureSize
        const iy = Math.floor(i / textureSize)
        positions[i * 3] = 0
        positions[i * 3 + 1] = 0
        positions[i * 3 + 2] = 0
        uvs[i * 2] = (ix + 0.5) / textureSize
        uvs[i * 2 + 1] = (iy + 0.5) / textureSize
      }

      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3))
      geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2))

      // Particle material (squares)
      const material = new THREE.ShaderMaterial({
        uniforms: {
          texturePosition: { value: null },
          videoTexture: { value: videoTexture },
          uRadius: { value: radius },
          videoAspect: { value: 16 / 9 },
          screenAspect: { value: outputWidth / outputHeight },
        },
        vertexShader: `
          uniform sampler2D texturePosition;
          uniform sampler2D videoTexture;
          uniform float uRadius;
          uniform float videoAspect;
          uniform float screenAspect;
          varying float vBrightness;

          void main() {
            vec4 posData = texture2D(texturePosition, uv);
            vec3 pos = vec3(posData.xy, 0.0);
            
            // Sample video for size variation
            vec2 videoUV = pos.xy * 0.5 + 0.5;
            videoUV.x = 1.0 - videoUV.x;
            
            float coverScale = max(screenAspect / videoAspect, 1.0);
            if (screenAspect < videoAspect) {
              coverScale = max(videoAspect / screenAspect, 1.0);
            }
            videoUV = (videoUV - 0.5) / coverScale + 0.5;
            
            vec4 videoColor = texture2D(videoTexture, videoUV);
            vBrightness = dot(videoColor.rgb, vec3(0.299, 0.587, 0.114));
            
            // Particles in dark areas are larger
            float sizeMult = mix(2.0, 0.5, vBrightness);
            
            gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
            gl_PointSize = uRadius * sizeMult;
          }
        `,
        fragmentShader: `
          void main() {
            // Square particles
            gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
          }
        `,
      })

      particleMesh = new THREE.Points(geometry, material)
      scene.add(particleMesh)
      return true
    }

    const animate = () => {
      animationId = requestAnimationFrame(animate)

      if (!gpuCompute || !renderer || !scene || !camera) return

      // Update uniforms from refs
      const p = paramsRef.current
      velocityVariable.material.uniforms.uThreshold.value = p.threshold
      velocityVariable.material.uniforms.uAttraction.value = p.attraction
      velocityVariable.material.uniforms.uRepulsion.value = p.repulsion
      velocityVariable.material.uniforms.uReturnStrength.value = p.returnStrength
      velocityVariable.material.uniforms.uFriction.value = p.friction
      velocityVariable.material.uniforms.uInverted.value = p.inverted ? 1.0 : 0.0
      velocityVariable.material.uniforms.uActive.value = p.isSimulationActive ? 1.0 : 0.0

      // Update video aspect
      if (video.videoWidth && video.videoHeight) {
        const videoAspect = video.videoWidth / video.videoHeight
        const screenAspect = outputWidth / outputHeight
        velocityVariable.material.uniforms.videoAspect.value = videoAspect
        velocityVariable.material.uniforms.screenAspect.value = screenAspect
        ;(particleMesh.material as THREE.ShaderMaterial).uniforms.videoAspect.value = videoAspect
        ;(particleMesh.material as THREE.ShaderMaterial).uniforms.screenAspect.value = screenAspect
      }

      // Update radius from ref
      ;(particleMesh.material as THREE.ShaderMaterial).uniforms.uRadius.value = p.radius

      // Update video texture
      videoTexture.needsUpdate = true

      // Compute
      gpuCompute.compute()

      // Update particle positions
      ;(particleMesh.material as THREE.ShaderMaterial).uniforms.texturePosition.value =
        gpuCompute.getCurrentRenderTarget(positionVariable).texture

      renderer.render(scene, camera)
      publishFrame.current(canvas)
    }

    // Handle resize
    const handleResize = () => {
      if (!renderer || !container) return
      renderer.setSize(outputWidth, outputHeight, false)

      // Update hand overlay size
      if (handOverlayRef.current) {
        handOverlayRef.current.width = outputWidth
        handOverlayRef.current.height = outputHeight
      }
    }

    window.addEventListener("resize", handleResize)

    // Initialize
    if (init()) {
      handleResize()
      animate()
    }

    return () => {
      window.removeEventListener("resize", handleResize)
      cancelAnimationFrame(animationId)
      gpuCompute?.dispose()
      positionVariable?.material.dispose()
      velocityVariable?.material.dispose()
      particleMesh?.geometry.dispose()
      if (particleMesh) {
        ;(particleMesh.material as THREE.ShaderMaterial).dispose()
      }
      videoTexture?.dispose()
      renderer?.clear()
      renderer?.dispose()
    }
  }, [isPlaying, particleCountBase, publishFrame])

  // Hand tracking loop
  useEffect(() => {
    if (!handLandmarker || !videoRef.current || !handOverlayRef.current || controlMode !== "hands") return

    const video = videoRef.current
    const overlay = handOverlayRef.current
    const ctx = overlay.getContext("2d")
    if (!ctx) return

    let rafId: number
    let lastVideoTime = -1

    const detect = () => {
      rafId = requestAnimationFrame(detect)

      if (video.currentTime === lastVideoTime || video.paused || video.ended) return
      lastVideoTime = video.currentTime

      const results = handLandmarker.detectForVideo(video, performance.now())

      // Clear overlay
      ctx.clearRect(0, 0, overlay.width, overlay.height)

      if (results.landmarks && results.landmarks.length > 0) {
        let activationHand: (typeof results.landmarks)[0] | null = null
        let controlHand: (typeof results.landmarks)[0] | null = null

        // Identify hands
        for (let i = 0; i < results.landmarks.length; i++) {
          const landmarks = results.landmarks[i]

          // Check if fist (activation gesture)
          const isFist = checkFist(landmarks)

          if (isFist && !activationHand) {
            activationHand = landmarks
          } else if (!isFist && !controlHand) {
            controlHand = landmarks
          }
        }

        // Draw bounding boxes
        for (let i = 0; i < results.landmarks.length; i++) {
          const landmarks = results.landmarks[i]
          const isActivation = landmarks === activationHand
          const isControl = landmarks === controlHand && activationHand !== null

          drawBoundingBox(ctx, landmarks, overlay.width, overlay.height, isActivation, isControl, !!activationHand)
        }

        // Process control gestures if activation hand is present
        if (activationHand && controlHand && !isLocked) {
          processControlGestures(controlHand)
        }
      }
    }

    detect()

    return () => {
      cancelAnimationFrame(rafId)
    }
  }, [handLandmarker, controlMode, isLocked])

  const checkFist = (landmarks: Array<{ x: number; y: number; z: number }>) => {
    // Check if fingers are curled (fist)
    const fingerTips = [8, 12, 16, 20] // Index, middle, ring, pinky tips
    const fingerPips = [6, 10, 14, 18] // PIPs

    let curledCount = 0
    for (let i = 0; i < fingerTips.length; i++) {
      if (landmarks[fingerTips[i]].y > landmarks[fingerPips[i]].y) {
        curledCount++
      }
    }
    return curledCount >= 3
  }

  const processControlGestures = (landmarks: Array<{ x: number; y: number; z: number }>) => {
    // Rotation: angle of wrist to middle finger base
    const wrist = landmarks[0]
    const middleBase = landmarks[9]
    const angle = Math.atan2(middleBase.y - wrist.y, middleBase.x - wrist.x)
    const normalizedAngle = (angle + Math.PI) / (2 * Math.PI)
    setRadius(1 + normalizedAngle * 9) // 1-10

    // Pinch: thumb to index distance for threshold
    const thumb = landmarks[4]
    const index = landmarks[8]
    const pinchDist = Math.sqrt(Math.pow(thumb.x - index.x, 2) + Math.pow(thumb.y - index.y, 2))
    setThreshold(Math.max(0, Math.min(1, pinchDist * 5)))

    // Spread: pinky to index distance for attraction
    const pinky = landmarks[20]
    const spreadDist = Math.sqrt(Math.pow(pinky.x - index.x, 2) + Math.pow(pinky.y - index.y, 2))
    setAttraction(Math.max(0, Math.min(2, spreadDist * 5)))
  }

  const drawBoundingBox = (
    ctx: CanvasRenderingContext2D,
    landmarks: Array<{ x: number; y: number; z: number }>,
    width: number,
    height: number,
    isActivation: boolean,
    isControl: boolean,
    hasActivation: boolean,
  ) => {
    // Calculate bounding box
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity

    for (const lm of landmarks) {
      const x = (1 - lm.x) * width // Mirror
      const y = lm.y * height
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }

    const padding = 20
    minX -= padding
    minY -= padding
    maxX += padding
    maxY += padding

    const isActive = isActivation || isControl

    // Draw outer border (black for contrast)
    ctx.strokeStyle = "#000"
    ctx.lineWidth = isActive ? 4 : 3
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY)

    // Draw inner border (white)
    ctx.strokeStyle = "#fff"
    ctx.lineWidth = isActive ? 2 : 1

    if (!isActive && !hasActivation) {
      // Dashed line for inactive
      ctx.setLineDash([1, 3])
    } else {
      ctx.setLineDash([])
    }

    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY)
    ctx.setLineDash([])

    // Label
    ctx.font = "12px ui-monospace, 'JetBrains Mono', monospace"
    ctx.fillStyle = "#000"
    ctx.fillText(isActivation ? "ACTIVATION" : isControl ? "CONTROLLER" : "WAITING", minX + 6, minY + 16)
    ctx.fillStyle = "#fff"
    ctx.fillText(isActivation ? "ACTIVATION" : isControl ? "CONTROLLER" : "WAITING", minX + 5, minY + 15)
  }

  const handleReset = () => {
    setDensityValue(clampDensity(density))
    setThreshold(0.64)
    setAttraction(1.58)
    setRepulsion(0.75)
    setReturnStrength(0.55)
    setRadius(1)
    setFriction(0.89)
  }

  const handleCopy = () => {
    const config = {
      density: densityValue,
      particleCount,
      threshold,
      attraction,
      repulsion,
      returnStrength,
      radius,
      friction,
      inverted,
    }
    navigator.clipboard.writeText(JSON.stringify(config, null, 2))
  }

  return (
    <div ref={containerRef} className="w-full h-screen bg-black overflow-hidden relative">
      {/* Hidden video element */}
      <video ref={videoRef} className="hidden" playsInline muted crossOrigin="anonymous" />

      {/* WebGL canvas */}
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full object-contain" />

      {/* Hand tracking overlay */}
      <canvas ref={handOverlayRef} className="absolute inset-0 w-full h-full object-contain pointer-events-none" />

      {/* Error display */}
      {error && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-red-500/90 text-white px-4 py-2 rounded-lg">
          {error}
        </div>
      )}

      {/* DialKit-style floating panel */}
      <FloatingPanel title="Controls" position="top-right" onCopy={handleCopy}>
        <Button label={isWebcamActive ? "Stop camera" : "Start camera"} onClick={() => {
          setIsPlaying(false)
          setIsWebcamActive(!isWebcamActive)
          setError(null)
        }} />
        <NativeCameraStatus status={nativeCamera.status} frameError={nativeCamera.frameError} active={isPlaying && isWebcamActive} />
        {/* Mode selector */}
        <SegmentedControl
          value={controlMode}
          options={[
            { value: "sliders", label: "Sliders" },
            { value: "hands", label: "Hands" },
          ]}
          onChange={(v) => setControlMode(v as "sliders" | "hands")}
        />

        {/* Camera selector */}
        {videoDevices.length > 0 && (
          <SelectControl
            label="Camera"
            value={selectedVideoDeviceId}
            options={[{ value: "", label: "System default" }, ...videoDevices.map((d) => ({
              value: d.deviceId,
              label: d.label || `Camera ${d.deviceId.slice(0, 8)}`,
            }))]}
            onChange={(id) => { if (id !== selectedVideoDeviceId) { setIsPlaying(false); setSelectedVideoDeviceId(id) } }}
          />
        )}

        <Slider label="Density (×)" value={densityValue} onChange={setDensityValue} min={0.25} max={16} step={0.25} />
        <div className="px-[10px] text-[11px]" style={{ color: "var(--dial-text-tertiary)" }}>
          {particleCount.toLocaleString("en-US")} dots
        </div>

        {controlMode === "sliders" ? (
          <>
            {/* Particle controls */}
            <Slider label="Threshold" value={threshold} onChange={setThreshold} min={0} max={1} step={0.01} />

            <Slider label="Attraction" value={attraction} onChange={setAttraction} min={0} max={2} step={0.01} />

            <Slider label="Repulsion" value={repulsion} onChange={setRepulsion} min={0} max={1} step={0.01} />

            <Slider
              label="Grid return"
              value={returnStrength}
              onChange={setReturnStrength}
              min={0}
              max={1}
              step={0.01}
            />

            <Slider label="Size" value={radius} onChange={setRadius} min={1} max={10} step={0.1} />

            <Slider label="Friction" value={friction} onChange={setFriction} min={0} max={1} step={0.01} />

            {/* Toggles */}
            <Toggle label="Invert Attraction" checked={inverted} onChange={setInverted} />

            <Toggle
              label={isSimulationActive ? "Simulation On" : "Simulation Off"}
              checked={isSimulationActive}
              onChange={setIsSimulationActive}
            />

            {/* Actions */}
            <Button label="Reset to Defaults" onClick={handleReset} />
          </>
        ) : (
          <>
            {/* Hand mode instructions */}
            <Folder title="Instructions" defaultOpen>
              <div className="text-[13px] space-y-2" style={{ color: "rgba(255,255,255,0.7)" }}>
                <p>1. Make a FIST with one hand to activate controls</p>
                <p>2. Use other hand to control parameters:</p>
                <p className="pl-4">- Rotate hand: Size</p>
                <p className="pl-4">- Pinch fingers: Threshold</p>
                <p className="pl-4">- Spread fingers: Attraction</p>
                <p className="mt-2">Snap or clap to lock/unlock preset</p>
              </div>
            </Folder>

            {/* Mic selector */}
            {audioDevices.length > 1 && (
              <SelectControl
                label="Microphone"
                value={selectedAudioDeviceId}
                options={audioDevices.map((d) => ({
                  value: d.deviceId,
                  label: d.label || `Mic ${d.deviceId.slice(0, 8)}`,
                }))}
                onChange={setSelectedAudioDeviceId}
              />
            )}

            {/* Live feedback sliders (read-only) */}
            <Folder title="Live Values" defaultOpen={false}>
              <Slider label="Size" value={radius} onChange={() => {}} min={1} max={10} step={0.1} disabled />
              <Slider label="Threshold" value={threshold} onChange={() => {}} min={0} max={1} step={0.01} disabled />
              <Slider label="Attraction" value={attraction} onChange={() => {}} min={0} max={2} step={0.01} disabled />
            </Folder>

            {/* Lock status */}
            <div
              className="text-center py-2 rounded-lg"
              style={{
                background: isLocked ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.05)",
                color: isLocked ? "#fff" : "rgba(255,255,255,0.5)",
              }}
            >
              {isLocked ? "PRESET LOCKED" : "PRESET UNLOCKED"}
            </div>
          </>
        )}
      </FloatingPanel>
    </div>
  )
}
