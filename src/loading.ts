import { useSyncExternalStore } from 'react'

type State = {
  label: string // download text or error text
  downloading: boolean
  progress: number | null // 0..1, or null when the size isn't known
  splatReady: boolean
  fieldReady: boolean
  failed: boolean
}

let state: State = { label: 'Downloading splat', downloading: true, progress: 0, splatReady: false, fieldReady: false, failed: false }
const listeners = new Set<() => void>()

export function setLoading(next: Partial<State>) {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

export function useLoading() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state,
  )
}
