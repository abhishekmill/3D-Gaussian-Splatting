import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  Euler,
  Group,
  Matrix4,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Center, OrbitControls, PivotControls, Splat, useGLTF } from '@react-three/drei'
import { button, useControls } from 'leva'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { buildDistanceField, emptyField, loadDensePoints, nearest } from './proximity'
import { SceneStateSerializer } from './sceneState'
import { setLoading, useLoading } from './loading'

// Put your files in /public
const SPLAT_URL = '/room.splat'
const MODEL_URL = '/GearboxAssy.glb'

// The splat loader needs a Content-Length header, which hosts drop when they compress or stream big files.
// Download the file ourselves (this also gives us progress) and hand the loader an in-memory blob URL,
// which the density pass reuses too.
async function downloadSplat() {
  try {
    const res = await fetch(SPLAT_URL)
    if (!res.ok || !res.body) throw new Error(`Could not load ${SPLAT_URL}: ${res.status}`)
    const total = Number(res.headers.get('Content-Length')) || 0
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let loaded = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      loaded += value.length
      setLoading({
        label: `Downloading splat (${(loaded / 1e6).toFixed(0)} MB)`,
        progress: total ? Math.min(1, loaded / total) : null,
      })
    }
    setLoading({ downloading: false, progress: null })
    return URL.createObjectURL(new Blob(chunks as BlobPart[]))
  } catch (e) {
    console.error(e)
    setLoading({ label: 'Could not load the splat', failed: true })
    throw e
  }
}
const splatBlobUrl = downloadSplat()

// Default preset. Paste a copied preset's values here to make it permanent.
const PRESET = {
  splat: { offsetX: 0, floorHeight: 7.1, offsetZ: 0, scale: 2.16, rotX: 332, rotY: 7, rotZ: 4 },
  model: { x: 0, y: 6.6, z: 0, scale: 7.42, rotX: -2, rotY: 1, rotZ: 4 },
  camera: {
    fov: 50,
    position: [1.8555283491986843, 7.649143978078703, 15.347145392993102],
    target: [1.8289938805538697, 3.4741219462392743, -0.28983847752687286],
  },
  shadowFloorY: 0,
  shadowPlaneSize: 16,
  shadowOffsetX: 0,
  shadowOffsetZ: 0,
  // light shines along its local -Z axis, rotation order YXZ
  light: { x: -6.1, y: 16, z: 4, rotX: -69, rotY: 45, rotZ: 0, intensity: 2, shadowArea: 8 },
}

const rad = MathUtils.degToRad
const num = (v: number, step = 0.01) => ({ value: v, step })

// Shared by every patched material and updated each frame in Scene
const uniforms = {
  uDistance: { value: 99 },
  uRange: { value: 3 },
  uNearest: { value: new Vector3() },
  uGlowColor: { value: new Color() },
  // distance field of the splat, see proximity.ts
  uField: { value: emptyField().texture },
  uFieldMin: { value: new Vector3() },
  uFieldSize: { value: new Vector3(1, 1, 1) },
  uSplatInv: { value: new Matrix4() },
  uSplatScale: { value: 1 },
}

function Scene() {
  const { camera } = useThree()
  const controls = useRef<OrbitControlsImpl>(null)

  // splat alignment is fixed
  const splat = PRESET.splat
  const [model, setModel] = useControls('Model', () => ({
    x: num(PRESET.model.x),
    y: num(PRESET.model.y),
    z: num(PRESET.model.z),
    scale: { value: PRESET.model.scale, min: 0.05, max: 10, step: 0.01 },
    rotX: num(PRESET.model.rotX, 1),
    rotY: num(PRESET.model.rotY, 1),
    rotZ: num(PRESET.model.rotZ, 1),
  }))
  const prox = useControls('Proximity', {
    range: { value: 3, min: 0.1, max: 10, step: 0.1 },
    glowColor: '#ff6a00',
    showDense: false,
  })
  const { shadowFloorY, shadowPlaneSize, shadowOffsetX, shadowOffsetZ, showShadowPlane, showGrid } = useControls('Floor', {
    shadowFloorY: num(PRESET.shadowFloorY),
    shadowPlaneSize: { value: PRESET.shadowPlaneSize, min: 0.5, max: 60, step: 0.5 },
    shadowOffsetX: num(PRESET.shadowOffsetX, 0.1),
    shadowOffsetZ: num(PRESET.shadowOffsetZ, 0.1),
    showShadowPlane: false,
    showGrid: true,
  })
  const light = useControls('Light', {
    x: num(PRESET.light.x, 0.1),
    y: num(PRESET.light.y, 0.1),
    z: num(PRESET.light.z, 0.1),
    rotX: num(PRESET.light.rotX, 1),
    rotY: num(PRESET.light.rotY, 1),
    rotZ: num(PRESET.light.rotZ, 1),
    intensity: { value: PRESET.light.intensity, min: 0, max: 10, step: 0.1 },
    autoFitShadow: true,
    shadowArea: { value: PRESET.light.shadowArea, min: 1, max: 30, step: 0.5 },
  })
  const lightRef = useRef<DirectionalLight>(null)
  const lightTarget = useRef<Object3D>(null)
  useEffect(() => {
    lightRef.current!.target = lightTarget.current!
  }, [])
  // keep the whole model inside the shadow camera, otherwise the shadow gets cut off
  const fit = useMemo(
    () => ({ box: new Box3(), c: new Vector3(), f: new Vector3(), d: new Vector3(), lp: new Vector3(), e: new Euler(0, 0, 0, 'YXZ') }),
    [],
  )
  useFrame(() => {
    if (!lightRef.current || !group.current) return
    const { box, c, f, d, lp, e } = fit
    let area = light.shadowArea
    if (light.autoFitShadow) {
      box.setFromObject(group.current)
      box.getCenter(c)
      const radius = box.getSize(d).length() / 2
      f.set(0, 0, -1).applyEuler(e.set(rad(light.rotX), rad(light.rotY), rad(light.rotZ), 'YXZ'))
      d.copy(c).sub(lp.set(light.x, light.y, light.z))
      area = d.sub(f.multiplyScalar(d.dot(f))).length() + radius + 0.5
    }
    const cam = lightRef.current.shadow.camera
    if (Math.abs(cam.right - area) > 0.02 || cam.far !== 300) {
      cam.left = cam.bottom = -area
      cam.right = cam.top = area
      cam.near = 0.1
      cam.far = 300
      cam.updateProjectionMatrix()
    }
  })
  const cam = useControls('Camera', { fov: { value: PRESET.camera.fov, min: 10, max: 120 } })

  const group = useRef<Group>(null)
  const syncModel = () => {
    const g = group.current!
    setModel({
      x: g.position.x,
      y: g.position.y,
      z: g.position.z,
      scale: g.scale.x,
      rotX: MathUtils.radToDeg(g.rotation.x),
      rotY: MathUtils.radToDeg(g.rotation.y),
      rotZ: MathUtils.radToDeg(g.rotation.z),
    })
  }
  useControls('State', {
    'Save mesh state': button(() => SceneStateSerializer.save(group.current!)),
    'Load mesh state': button(() => SceneStateSerializer.load(group.current!) && syncModel()),
  })
  // restore saved state on startup
  useEffect(() => {
    if (SceneStateSerializer.load(group.current!)) syncModel()
  }, [])

  useControls('Preset', {
    'Copy preset': button(() => {
      const preset = {
        splat,
        model,
        shadowFloorY,
        shadowPlaneSize,
        shadowOffsetX,
        shadowOffsetZ,
        light,
        camera: {
          fov: cam.fov,
          position: camera.position.toArray(),
          target: controls.current?.target.toArray(),
        },
      }
      const text = JSON.stringify(preset, null, 2)
      console.log(text)
      navigator.clipboard.writeText(text)
    }),
  })

  // the gearbox is modelled in large units, normalise it to ~1 unit
  const { scene } = useGLTF(MODEL_URL)
  const base = useMemo(() => {
    const size = new Box3().setFromObject(scene).getSize(new Vector3())
    return 1 / Math.max(size.x, size.y, size.z)
  }, [scene])

  // depth sync: the mesh is opaque and writes depth, the splat tests depth but doesn't write it,
  // so splats in front of the mesh draw over it and splats behind it are rejected
  const splatGroup = useRef<Group>(null)
  const splatConfigured = useRef(false)
  useFrame(() => {
    if (splatConfigured.current) return
    splatGroup.current?.traverse((o) => {
      const mat = (o as Mesh).material as ShaderMaterial | undefined
      if (!mat) return
      mat.transparent = true
      mat.depthTest = true
      mat.depthWrite = false
      splatConfigured.current = true
    })
  })

  // shadows
  useEffect(() => {
    scene.traverse((o) => {
      o.castShadow = o.receiveShadow = true
    })
  }, [scene])

  // proximity glow, driven by the uniforms updated in useFrame
  useEffect(() => {
    scene.traverse((o) => {
      const mesh = o as Mesh
      if (!mesh.isMesh) return
      const mat = (mesh.material as MeshStandardMaterial).clone()
      mat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms)
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
          .replace(
            '#include <begin_vertex>',
            '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNormal = mat3(modelMatrix) * objectNormal;',
          )
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            `#include <common>
            varying vec3 vWPos;
            varying vec3 vWNormal;
            uniform highp sampler3D uField;
            uniform vec3 uFieldMin;
            uniform vec3 uFieldSize;
            uniform mat4 uSplatInv;
            uniform float uSplatScale;
            uniform float uRange;
            uniform vec3 uGlowColor;`,
          )
          .replace(
            '#include <opaque_fragment>',
            `// distance to the nearest dense splat area, sampled in splat space
            vec3 lp = (uSplatInv * vec4(vWPos, 1.0)).xyz;
            vec3 inside = clamp(lp, uFieldMin, uFieldMin + uFieldSize);
            float dist = (texture(uField, (inside - uFieldMin) / uFieldSize).r + length(lp - inside)) * uSplatScale;
            float near = 1.0 - smoothstep(0.0, uRange, dist);
            outgoingLight = mix(outgoingLight, uGlowColor, near * 0.6) + uGlowColor * near * 0.4;
            #include <opaque_fragment>`,
          )
      }
      mesh.material = mat
    })
  }, [scene])

  // debug estimate: distance from the bounding box centre and corners to the nearest dense point
  const dense = useRef<Float32Array | null>(null)
  const [densePts, setDensePts] = useState<Float32Array | null>(null)
  const marker = useRef<Mesh>(null)
  const lineData = useMemo(() => {
    const positions = new Float32Array(9 * 6)
    const colors = new Float32Array(9 * 6)
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(positions, 3))
    geometry.setAttribute('color', new BufferAttribute(colors, 3))
    return { positions, colors, geometry }
  }, [])
  const [splatUrl, setSplatUrl] = useState<string>()
  useEffect(() => {
    splatBlobUrl.then(setSplatUrl)
  }, [])
  useEffect(() => {
    if (!splatUrl) return
    // let the label paint before the heavy synchronous work
    new Promise((r) => setTimeout(r, 50)).then(() => loadDensePoints(splatUrl)).then((p) => {
      dense.current = p
      setDensePts(p)
      const field = buildDistanceField(p)
      uniforms.uField.value = field.texture
      uniforms.uFieldMin.value.copy(field.min)
      uniforms.uFieldSize.value.copy(field.size)
      setLoading({ fieldReady: true })
    })
  }, [splatUrl])
  const tmp = useMemo(() => {
    // splat alignment never changes, build its matrix once
    const splatMatrix = new Matrix4().compose(
      new Vector3(splat.offsetX, splat.floorHeight, splat.offsetZ),
      new Quaternion().setFromEuler(new Euler(rad(splat.rotX), rad(splat.rotY), rad(splat.rotZ))),
      new Vector3(splat.scale, splat.scale, splat.scale),
    )
    return {
      box: new Box3(),
      pts: Array.from({ length: 9 }, () => new Vector3()),
      local: new Vector3(),
      splatMatrix,
      inv: splatMatrix.clone().invert(),
      hit: new Vector3(),
    }
  }, [splat])
  useFrame(() => {
    if (!dense.current || !group.current) return
    const { box, pts, local, splatMatrix, inv, hit } = tmp
    box.setFromObject(group.current)
    box.getCenter(pts[0])
    for (let i = 0; i < 8; i++)
      pts[i + 1].set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)

    // one line per sample point, the shortest one is the distance
    const lines = lineData.positions
    let best = Infinity
    let bestIndex = 0
    pts.forEach((p, i) => {
      const d = nearest(dense.current!, local.copy(p).applyMatrix4(inv), hit) * splat.scale
      hit.applyMatrix4(splatMatrix)
      p.toArray(lines, i * 6)
      hit.toArray(lines, i * 6 + 3)
      if (d < best) {
        best = d
        bestIndex = i
        uniforms.uNearest.value.copy(hit)
      }
    })
    lineData.colors.fill(1, 0, 54)
    for (let k = 0; k < 6; k++) lineData.colors[bestIndex * 6 + k] = k % 3 === 1 ? 0 : 1
    lineData.geometry.attributes.position.needsUpdate = true
    lineData.geometry.attributes.color.needsUpdate = true
    uniforms.uDistance.value = best
    uniforms.uSplatInv.value.copy(inv)
    uniforms.uSplatScale.value = splat.scale
    marker.current?.position.copy(uniforms.uNearest.value)
    const readout = document.getElementById('distance')
    if (readout) readout.textContent = `distance ${best.toFixed(2)} / range ${prox.range}  glow ${Math.round((1 - MathUtils.smoothstep(best, 0, prox.range)) * 100)}%`
    uniforms.uRange.value = prox.range
    uniforms.uGlowColor.value.set(prox.glowColor)
  })

  // pivot gizmo, writes back into the Model controls
  const pivotMatrix = useMemo(
    () =>
      new Matrix4().compose(
        new Vector3(model.x, model.y, model.z),
        new Quaternion().setFromEuler(new Euler(rad(model.rotX), rad(model.rotY), rad(model.rotZ))),
        new Vector3(1, 1, 1),
      ),
    [model.x, model.y, model.z, model.rotX, model.rotY, model.rotZ],
  )
  const onPivotDrag = (l: Matrix4) => {
    const position = new Vector3()
    const quaternion = new Quaternion()
    l.decompose(position, quaternion, new Vector3())
    const e = new Euler().setFromQuaternion(quaternion)
    setModel({
      x: position.x,
      y: position.y,
      z: position.z,
      rotX: MathUtils.radToDeg(e.x),
      rotY: MathUtils.radToDeg(e.y),
      rotZ: MathUtils.radToDeg(e.z),
    })
  }

  return (
    <>
      <PivotControls
        matrix={pivotMatrix}
        autoTransform={false}
        disableScaling
        fixed
        scale={110}
        depthTest={false}
        onDrag={onPivotDrag}
      />
      <ambientLight intensity={0.6} />
      <group
        position={[light.x, light.y, light.z]}
        rotation={new Euler(rad(light.rotX), rad(light.rotY), rad(light.rotZ), 'YXZ')}
      >
        <directionalLight
          ref={lightRef}
          intensity={light.intensity}
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-bias={-0.0005}
          shadow-normalBias={0.05}
        />
        <object3D ref={lightTarget} position={[0, 0, -1]} />
      </group>
      {/* shadow plane, follows the model in x/z plus an offset */}
      <group position={[model.x + shadowOffsetX, shadowFloorY, model.z + shadowOffsetZ]} rotation={[-Math.PI / 2, 0, 0]}>
        <mesh receiveShadow renderOrder={5}>
          <planeGeometry args={[shadowPlaneSize, shadowPlaneSize]} />
          <shadowMaterial opacity={0.5} depthWrite={false} />
        </mesh>
        {showShadowPlane && (
          <mesh renderOrder={6}>
            <planeGeometry args={[shadowPlaneSize, shadowPlaneSize]} />
            <meshBasicMaterial color="#ffee00" transparent opacity={0.2} depthTest={false} depthWrite={false} />
          </mesh>
        )}
      </group>
      <group ref={splatGroup}>
        {splatUrl && (
          <Suspense fallback={null}>
            <Splat
              src={splatUrl}
              position={[splat.offsetX, splat.floorHeight, splat.offsetZ]}
              scale={splat.scale}
              rotation={[rad(splat.rotX), rad(splat.rotY), rad(splat.rotZ)]}
            />
            <SplatReady />
          </Suspense>
        )}
      </group>
      {prox.showDense && densePts && (
        <group
          position={[splat.offsetX, splat.floorHeight, splat.offsetZ]}
          scale={splat.scale}
          rotation={[rad(splat.rotX), rad(splat.rotY), rad(splat.rotZ)]}
        >
          <points renderOrder={10}>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[densePts, 3]} />
            </bufferGeometry>
            <pointsMaterial size={0.12} color="#00ff88" transparent depthTest={false} depthWrite />
          </points>
        </group>
      )}
      {prox.showDense && (
        <lineSegments geometry={lineData.geometry} renderOrder={12} frustumCulled={false}>
          <lineBasicMaterial vertexColors transparent depthTest={false} depthWrite />
        </lineSegments>
      )}
      {prox.showDense && (
        <mesh ref={marker} renderOrder={11}>
          <sphereGeometry args={[0.15]} />
          <meshBasicMaterial color="#ff00ff" transparent depthTest={false} depthWrite />
        </mesh>
      )}
      <group
        ref={group}
        position={[model.x, model.y, model.z]}
        scale={model.scale}
        rotation={[rad(model.rotX), rad(model.rotY), rad(model.rotZ)]}
      >
        <Center bottom scale={base}>
          <primitive object={scene} />
        </Center>
      </group>
      {showGrid && <gridHelper args={[10, 20, '#ff4d4d', '#00ffff']} position={[0, shadowFloorY, 0]} />}
      <OrbitControls
        ref={controls}
        makeDefault
        target={PRESET.camera.target as [number, number, number]}
        zoomToCursor
        screenSpacePanning
      />
      <CameraFov fov={cam.fov} />
    </>
  )
}

// rendered after the splat, so it only mounts once the splat has finished loading
function SplatReady() {
  useEffect(() => setLoading({ splatReady: true }), [])
  return null
}

function Loader() {
  const { label, downloading, progress, splatReady, fieldReady, failed } = useLoading()
  const done = splatReady && fieldReady
  const text = failed || downloading ? label : fieldReady ? 'Preparing splat' : 'Building proximity field'
  return (
    <div
      className={`absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/70 text-white transition-opacity duration-500 ${
        done ? 'pointer-events-none opacity-0' : ''
      }`}
    >
      <div className={`text-sm ${failed ? 'text-red-400' : ''}`}>{text}</div>
      <div className="h-1 w-56 overflow-hidden rounded bg-white/20">
        <div
          className={`h-full bg-white ${progress === null ? 'w-1/3 animate-pulse' : ''}`}
          style={progress === null ? undefined : { width: `${progress * 100}%` }}
        />
      </div>
    </div>
  )
}

function CameraFov({ fov }: { fov: number }) {
  const camera = useThree((s) => s.camera)
  if ('fov' in camera) {
    camera.fov = fov
    camera.updateProjectionMatrix()
  }
  return null
}

export default function App() {
  return (
    <div className="relative h-full w-full bg-black">
      <Loader />
      <div id="distance" className="absolute left-3 top-3 z-10 font-mono text-sm text-white" />
      <Canvas shadows camera={{ position: PRESET.camera.position as [number, number, number], fov: PRESET.camera.fov }}>
        <Suspense fallback={null}>
          <Scene />
        </Suspense>
      </Canvas>
    </div>
  )
}
