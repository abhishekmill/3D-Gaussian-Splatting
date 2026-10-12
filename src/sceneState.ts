import type { Object3D } from 'three'

const KEY = 'optellix.sceneState'

// Saves/loads an object's position, rotation (radians) and scale as JSON in localStorage.
export const SceneStateSerializer = {
  serialize(obj: Object3D): string {
    return JSON.stringify({
      position: obj.position.toArray(),
      rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
      scale: obj.scale.toArray(),
    })
  },

  deserialize(json: string, obj: Object3D) {
    const s = JSON.parse(json)
    obj.position.fromArray(s.position)
    obj.rotation.set(...(s.rotation as [number, number, number]))
    obj.scale.fromArray(s.scale)
  },

  save(obj: Object3D) {
    localStorage.setItem(KEY, this.serialize(obj))
  },

  // Returns false when nothing is saved or the data is invalid
  load(obj: Object3D): boolean {
    try {
      const json = localStorage.getItem(KEY)
      if (!json) return false
      this.deserialize(json, obj)
      return true
    } catch {
      return false
    }
  },
}
