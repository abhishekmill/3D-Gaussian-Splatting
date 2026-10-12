import { Data3DTexture, DataUtils, HalfFloatType, LinearFilter, RedFormat, Vector3 } from 'three'

const FIELD_CELL = 0.25 // splat-space units per distance-field cell
const FIELD_MAX = 8 // distances are capped here

export type DistanceField = { texture: Data3DTexture; min: Vector3; size: Vector3 }

function makeTexture(data: Uint16Array, w: number, h: number, d: number) {
  const t = new Data3DTexture(data, w, h, d)
  t.format = RedFormat
  t.type = HalfFloatType
  t.minFilter = t.magFilter = LinearFilter
  t.unpackAlignment = 1
  t.needsUpdate = true
  return t
}

// 1x1x1 placeholder so the shader has a valid sampler before the real field is built
export function emptyField(): DistanceField {
  const data = new Uint16Array([DataUtils.toHalfFloat(FIELD_MAX)])
  return { texture: makeTexture(data, 1, 1, 1), min: new Vector3(), size: new Vector3(1, 1, 1) }
}

// 1D squared-distance transform (Felzenszwalb) of f in place
function edt1d(f: Float32Array, n: number) {
  const v = new Int32Array(n)
  const z = new Float32Array(n + 1)
  const out = new Float32Array(n)
  let k = 0
  z[0] = -Infinity
  z[1] = Infinity
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = Infinity
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    out[q] = (q - v[k]) * (q - v[k]) + f[v[k]]
  }
  f.set(out)
}

// Builds a 3D texture holding, for every cell, the distance (splat space) to the nearest dense point.
export function buildDistanceField(points: Float32Array): DistanceField {
  // bounds: ignore the outermost 1% of points on each axis so stray splats don't blow up the grid
  const min = new Vector3()
  const max = new Vector3()
  for (let a = 0; a < 3; a++) {
    const vals = new Float32Array(points.length / 3)
    for (let i = 0; i < vals.length; i++) vals[i] = points[i * 3 + a]
    vals.sort()
    min.setComponent(a, vals[Math.floor(vals.length * 0.01)])
    max.setComponent(a, vals[Math.floor(vals.length * 0.99)])
  }
  const dims = [0, 1, 2].map((a) => Math.ceil((max.getComponent(a) - min.getComponent(a)) / FIELD_CELL) + 1)
  const [w, h, d] = dims
  const grid = new Float32Array(w * h * d).fill(1e6)
  for (let i = 0; i < points.length; i += 3) {
    const x = Math.floor((points[i] - min.x) / FIELD_CELL)
    const y = Math.floor((points[i + 1] - min.y) / FIELD_CELL)
    const z = Math.floor((points[i + 2] - min.z) / FIELD_CELL)
    if (x >= 0 && x < w && y >= 0 && y < h && z >= 0 && z < d) grid[x + w * (y + h * z)] = 0
  }

  // exact Euclidean distance transform, one axis at a time
  const line = new Float32Array(Math.max(w, h, d))
  const strides = [1, w, w * h]
  for (let a = 0; a < 3; a++) {
    const n = dims[a]
    const [b, c] = [0, 1, 2].filter((i) => i !== a)
    for (let j = 0; j < dims[b]; j++)
      for (let k = 0; k < dims[c]; k++) {
        const base = j * strides[b] + k * strides[c]
        const view = line.subarray(0, n)
        for (let i = 0; i < n; i++) view[i] = grid[base + i * strides[a]]
        edt1d(view, n)
        for (let i = 0; i < n; i++) grid[base + i * strides[a]] = view[i]
      }
  }

  const data = new Uint16Array(grid.length)
  for (let i = 0; i < grid.length; i++) data[i] = DataUtils.toHalfFloat(Math.min(FIELD_MAX, Math.sqrt(grid[i]) * FIELD_CELL))
  return { texture: makeTexture(data, w, h, d), min, size: new Vector3(w, h, d).multiplyScalar(FIELD_CELL) }
}

const VOXEL = 0.2 // splat-space units
const MIN_SPLATS = 8 // a voxel is "dense" when it holds at least this many opaque splats

// Reads a .splat file (32 bytes per splat: xyz float32 at 0, rgba at 24) and returns
// the centres of dense voxels as a flat xyz array in splat space.
export async function loadDensePoints(url: string): Promise<Float32Array> {
  const buf = await (await fetch(url)).arrayBuffer()
  const view = new DataView(buf)
  const cells = new Map<number, { n: number; x: number; y: number; z: number }>()

  for (let i = 0; i < buf.byteLength / 32; i++) {
    const o = i * 32
    if (view.getUint8(o + 27) < 128) continue
    const x = view.getFloat32(o, true)
    const y = view.getFloat32(o + 4, true)
    const z = view.getFloat32(o + 8, true)
    const key =
      ((Math.floor(x / VOXEL) + 1024) * 2048 + (Math.floor(y / VOXEL) + 1024)) * 2048 +
      (Math.floor(z / VOXEL) + 1024)
    const c = cells.get(key)
    if (c) {
      c.n++
      c.x += x
      c.y += y
      c.z += z
    } else cells.set(key, { n: 1, x, y, z })
  }

  const out: number[] = []
  for (const c of cells.values()) if (c.n >= MIN_SPLATS) out.push(c.x / c.n, c.y / c.n, c.z / c.n)
  return new Float32Array(out)
}

// Nearest dense point to p (both in splat space). Writes the point into `out`, returns distance.
export function nearest(points: Float32Array, p: Vector3, out: Vector3): number {
  let best = Infinity
  for (let i = 0; i < points.length; i += 3) {
    const dx = points[i] - p.x
    const dy = points[i + 1] - p.y
    const dz = points[i + 2] - p.z
    const d = dx * dx + dy * dy + dz * dz
    if (d < best) {
      best = d
      out.set(points[i], points[i + 1], points[i + 2])
    }
  }
  return Math.sqrt(best)
}
