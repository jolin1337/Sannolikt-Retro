/**
 * Room: one shared Y.Doc + Awareness per whiteboard, plus the WebSocket fan-out.
 *
 * The server never interprets document content. It relays sync messages, keeps an
 * authoritative Awareness view so it can tell peers that went away (hard kill, closed tab,
 * dropped network), and persists the raw Y.Doc update log to disk.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as mutex from 'lib0/mutex'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'

export const messageSync = 0
export const messageAwareness = 1
export const messageQueryAwareness = 3

const HERE = dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = resolve(process.env.COLABFLOW_DATA ?? join(HERE, '..', 'data'))
const SAVE_DEBOUNCE_MS = 1200
const ROOM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export const validRoom = (name) => typeof name === 'string' && ROOM_PATTERN.test(name)

/** Decode the client entries carried by an awareness update (for per-connection liveness). */
const awarenessEntries = (update) => {
  const decoder = decoding.createDecoder(update)
  const len = decoding.readVarUint(decoder)
  const entries = []
  for (let i = 0; i < len; i++) {
    const id = decoding.readVarUint(decoder)
    decoding.readVarUint(decoder) // clock, unused here
    entries.push({ id, state: decoding.readVarString(decoder) })
  }
  return entries
}

const isOpen = (ws) => ws.readyState === 1

export class Room {
  /** @param {string} name validated room name */
  constructor(name) {
    this.name = name
    this.filePath = join(DATA_DIR, `${encodeURIComponent(name)}.bin`)
    this.doc = new Y.Doc({ gc: true })
    this.awareness = new awarenessProtocol.Awareness(this.doc)
    // The server is a relay, not a participant.
    this.awareness.setLocalState(null)

    /** @type {Set<Conn>} */
    this.conns = new Set()
    this.dirty = false
    this.closed = false
    this.saveTimer = null
    this.saving = false
    this.inflight = Promise.resolve()

    this.doc.on('update', (update, origin) => {
      if (origin === 'load') return
      // Updates applied on behalf of a connection must reach every other member.
      if (origin && this.conns.has(origin)) {
        const enc = encoding.createEncoder()
        encoding.writeVarUint(enc, messageSync)
        syncProtocol.writeUpdate(enc, update)
        this.broadcast(encoding.toUint8Array(enc), origin)
      }
      this.scheduleSave()
    })
    this.awareness.on('update', (updates, origin) => this.#broadcastAwareness(updates, origin))
  }

  /** Restore the persisted document. Missing file is not an error (new room). */
  async load() {
    try {
      const buf = await readFile(this.filePath)
      if (buf.byteLength > 0) {
        Y.applyUpdate(this.doc, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), 'load')
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') console.error(`[room ${this.name}] load failed:`, err)
    }
    this.dirty = false
  }

  scheduleSave() {
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.save().catch((err) => console.error(`[room ${this.name}] save failed:`, err))
    }, SAVE_DEBOUNCE_MS)
  }

  /**
   * Persist the document. `force` waits for an in-flight save to settle instead of
   * deferring to the debounced retry, so shutdown/teardown callers can rely on it.
   */
  async save(force = false) {
    if (this.saving) {
      if (!force) return
      await this.inflight
      if (!this.dirty) return
    }
    if (!this.dirty) return
    this.saving = true
    this.dirty = false
    const write = (async () => {
      try {
        const update = Y.encodeStateAsUpdate(this.doc)
        const tmp = `${this.filePath}.${process.pid}.tmp`
        await mkdir(dirname(this.filePath), { recursive: true })
        await writeFile(tmp, update)
        await rename(tmp, this.filePath)
      } catch (err) {
        this.dirty = true
        throw err
      } finally {
        this.saving = false
      }
    })()
    this.inflight = write
    await write
  }

  destroy() {
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.closed = true
    this.doc.destroy()
  }

  /** @returns {Conn} */
  addConn(ws) {
    const conn = { ws, room: this, mux: mutex.createMutex(), awarenessClients: new Set() }
    if (this.closed) return conn
    this.conns.add(conn)

    // Ask the newcomer for what it already has, and hand it the current presence.
    const sync = encoding.createEncoder()
    encoding.writeVarUint(sync, messageSync)
    syncProtocol.writeSyncStep1(sync, this.doc)
    this.send(conn, encoding.toUint8Array(sync))

    const ids = Array.from(this.awareness.getStates().keys())
    if (ids.length) {
      const aware = encoding.createEncoder()
      encoding.writeVarUint(aware, messageAwareness)
      encoding.writeVarUint8Array(
        aware,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, ids)
      )
      this.send(conn, encoding.toUint8Array(aware))
    }
    return conn
  }

  removeConn(conn) {
    this.conns.delete(conn)
    // Peers that stopped sending (killed tab, dropped socket) must vanish from presence and
    // therefore stop holding their sticker locks.
    awarenessProtocol.removeAwarenessStates(this.awareness, [...conn.awarenessClients], null)
  }

  send(conn, data) {
    if (isOpen(conn.ws)) conn.ws.send(data)
  }

  broadcast(data, except) {
    for (const conn of this.conns) if (conn !== except) this.send(conn, data)
  }

  #broadcastAwareness(updates, origin) {
    const ids = [...updates.added, ...updates.updated, ...updates.removed]
    if (!ids.length) return
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, messageAwareness)
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, ids)
    )
    this.broadcast(encoding.toUint8Array(enc), origin)
  }

  /** Handle one inbound frame from a connection. */
  handleMessage(conn, data) {
    conn.mux(() => {
      const decoder = decoding.createDecoder(data)
      const type = decoding.readVarUint(decoder)
      switch (type) {
        case messageSync: {
          const reply = encoding.createEncoder()
          encoding.writeVarUint(reply, messageSync)
          const messageType = syncProtocol.readSyncMessage(decoder, reply, this.doc, conn)
          // A SyncStep1 is answered privately with the missing state; anything else was folded
          // into the doc by readSyncMessage and reaches other peers via the update listener.
          if (messageType === syncProtocol.messageYjsSyncStep1) {
            this.send(conn, encoding.toUint8Array(reply))
          }
          break
        }
        case messageAwareness: {
          const update = decoding.readVarUint8Array(decoder)
          for (const entry of awarenessEntries(update)) {
            if (entry.state === null) conn.awarenessClients.delete(entry.id)
            else conn.awarenessClients.add(entry.id)
          }
          // origin = conn so the echo back to the sender is suppressed.
          awarenessProtocol.applyAwarenessUpdate(this.awareness, update, conn)
          break
        }
        case messageQueryAwareness: {
          const enc = encoding.createEncoder()
          encoding.writeVarUint(enc, messageAwareness)
          encoding.writeVarUint8Array(
            enc,
            awarenessProtocol.encodeAwarenessUpdate(
              this.awareness,
              Array.from(this.awareness.getStates().keys())
            )
          )
          this.send(conn, encoding.toUint8Array(enc))
          break
        }
        default:
          break
      }
    })
  }
}

/** Live room registry. Rooms are created on first join and torn down when empty. */
export class Rooms {
  constructor() {
    /** @type {Map<string, Room>} */
    this.map = new Map()
    /** @type {Map<string, Promise<Room>>} rooms whose disk state is still being restored */
    this.loading = new Map()
  }

  /** @returns {Promise<Room>|null} */
  get(name) {
    if (!validRoom(name)) return null
    const room = this.map.get(name)
    if (room) return Promise.resolve(room)
    let pending = this.loading.get(name)
    if (!pending) {
      const fresh = new Room(name)
      this.map.set(name, fresh)
      pending = fresh.load().then(() => {
        this.loading.delete(name)
        return fresh
      },
      (err) => {
        this.loading.delete(name)
        if (this.map.get(name) === fresh) this.map.delete(name)
        throw err
      })
      this.loading.set(name, pending)
    }
    return pending
  }

  /** Release a room once its last participant leaves. */
  async release(name, room) {
    if (room.conns.size > 0) return
    await room.save(true).catch(() => {})
    // A newcomer may have joined while the flush was in flight.
    if (room.conns.size > 0) return
    room.destroy()
    if (this.map.get(name) === room) this.map.delete(name)
  }

  /** Flush everything currently loaded. Used on shutdown. */
  async flush() {
    await Promise.all([...this.map.values()].map((room) => room.save(true)))
  }
}
