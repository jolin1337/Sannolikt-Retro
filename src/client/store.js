/**
 * Document + connection wiring for one board session.
 */
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { bindStores, colorFor } from './model.js'

export const NAME_KEY = 'colabflow:name'
export const ROOMS_KEY = 'colabflow:rooms'

/** Remember a name and which boards this browser opened. */
export const readName = () => localStorage.getItem(NAME_KEY) ?? ''
export const writeName = (name) => localStorage.setItem(NAME_KEY, name)
export const rememberRoom = (room) => {
  const list = readRooms()
  const next = [{ room, at: Date.now() }, ...list.filter((r) => r.room !== room)].slice(0, 6)
  localStorage.setItem(ROOMS_KEY, JSON.stringify(next))
}
export const readRooms = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(ROOMS_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((r) => r && typeof r.room === 'string') : []
  } catch {
    return []
  }
}

export const roomFromUrl = () => location.pathname.match(/^\/r\/([^/]+)/)?.[1] ?? null

/**
 * @param {string} room
 * @param {string} name
 */
export function connect (room, name) {
  const doc = new Y.Doc({ gc: true })
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  // The room goes in the path (not only the query) so the provider's BroadcastChannel de-dupes
  // per board when the same machine has several tabs open.
  const provider = new WebsocketProvider(`${protocol}//${location.host}/ws`, room, doc, {
    params: { room },
  })
  const stores = bindStores(doc)
  const me = {
    id: doc.clientID,
    name,
    color: colorFor(name, doc.clientID & 0xffff),
  }
  provider.awareness.setLocalState({ name, color: me.color, cursor: null, editing: null })
  return { doc, provider, stores, me, awareness: provider.awareness }
}

/** Status text for the header indicator. */
export function watchStatus (provider, awareness, onState) {
  const emit = () => {
    let state = 'offline'
    if (provider.synced) state = 'online'
    else if (provider.wsconnected || provider.wsconnecting) state = 'connecting'
    const peers = [...awareness.getStates().keys()].filter((c) => c !== awareness.clientID).length
    onState(state, provider.synced, peers)
  }
  provider.on('status', emit)
  provider.on('sync', emit)
  provider.on('synced', emit)
  awareness.on('change', emit)
  emit()
  return () => provider.removeAllListeners?.()
}
