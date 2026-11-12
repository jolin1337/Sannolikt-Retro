/**
 * End-to-end check of the collaboration guarantees, using the real server and real
 * y-websocket providers (Node 22+ provides the WebSocket global, so a browser is not needed).
 *
 *   node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process'
import { rmSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { bindStores, createElement, claimLock, releaseLock, holderOf, isLockedByOther, deleteElement, appendPoints, finishStroke, bringToFront, KIND, boundsOf, stackZ } from '../src/client/model.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = Number(process.env.SMOKE_PORT ?? 3399)
const ROOM = `smoke-${process.pid}`
const DATA = join(ROOT, 'data')

let passed = 0
let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name} ${extra}`)
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, { timeout = 6000, step = 25, label = '' } = {}) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (fn()) return true
    await wait(step)
  }
  return false
}

/** A minimal headless "browser tab": a doc, a provider and the three stores. */
function peer (name) {
  const doc = new Y.Doc({ gc: true })
  const provider = new WebsocketProvider(`ws://127.0.0.1:${PORT}/ws`, ROOM, doc, {
    params: { room: ROOM },
    awareness: undefined,
  })
  const stores = bindStores(doc)
  provider.awareness.setLocalState({ name, color: '#123456', cursor: null, editing: null })
  return {
    name,
    doc,
    provider,
    awareness: provider.awareness,
    ...stores,
    ready: () => provider.synced,
    elements: stores.elements,
    destroy: () => {
      provider.destroy()
      doc.destroy()
    },
  }
}

const server = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', COLABFLOW_DATA: DATA },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
server.stdout.on('data', (d) => {
  serverLog += d
})
server.stderr.on('data', (d) => {
  serverLog += d
})
server.on('exit', (code) => {
  if (code !== 0 && code !== null) console.error(serverLog)
})

const stopServer = () => {
  server.kill('SIGTERM')
  return new Promise((r) => server.on('exit', r))
}

async function start () {
  const end = Date.now() + 8000
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`)
      if (res.ok) return
    } catch {}
    await wait(100)
  }
  throw new Error(`server did not start\n${serverLog}`)
}

try {
  if (existsSync(join(DATA, `${ROOM}.bin`))) rmSync(join(DATA, `${ROOM}.bin`))
  mkdirSync(DATA, { recursive: true })
  await start()

  console.log('\nSync')
  const a = peer('Ada')
  const b = peer('Grace')
  ok('both peers reach synced', await until(() => a.ready() && b.ready(), { label: 'sync' }))

  createElement(a.doc, a.elements, a.meta, { kind: KIND.NOTE, x: 100, y: 50, text: 'hello', authorName: 'Ada' })
  const id = [...a.elements.keys()][0]
  ok('note replicated to peer', await until(() => b.elements.has(id)))
  ok('text replicates', b.elements.get(id).get('text') === 'hello')
  ok('element id survives transport', b.elements.get(id).get('id') === id)

  console.log('\nLive editing (per-sticker lock)')
  ok('A can claim the lock', claimLock(a.awareness, a.doc, a.locks, id))
  ok('B sees the sticker as locked by Ada', !!isLockedByOther(b.awareness, b.locks, id, b.doc.clientID))
  ok('B is told who holds it', holderOf(b.awareness, b.locks, id)?.name === 'Ada')
  const bWins = claimLock(b.awareness, b.doc, b.locks, id)
  ok('second claim is rejected', !bWins)
  ok('lock still belongs to A', holderOf(a.awareness, a.locks, id)?.by === a.doc.clientID)
  ok('B cannot delete a sticker Ada holds', deleteElement(b.awareness, b.locks, b.elements, id, b.doc.clientID) === false)
  const mine = createElement(a.doc, a.elements, a.meta, { kind: KIND.NOTE, x: 700, y: 700, text: 'mine' })
  const mineId = mine.get('id')
  claimLock(a.awareness, a.doc, a.locks, mineId)
  ok('the holder can delete their own locked sticker', deleteElement(a.awareness, a.locks, a.elements, mineId, a.doc.clientID) === true)
  ok('deleted sticker is gone for peers', await until(() => !b.elements.has(mineId)))
  ok('B can still edit an unlocked sticker', (() => {
    const other = createElement(b.doc, b.elements, b.meta, { kind: KIND.NOTE, x: 0, y: 0, text: 'x' })
    const okB = !isLockedByOther(b.awareness, b.locks, other.get('id'), b.doc.clientID) &&
      claimLock(b.awareness, b.doc, b.locks, other.get('id'))
    return okB && !!holderOf(a.awareness, a.locks, other.get('id'), b.doc.clientID)
  })())

  releaseLock(a.awareness, a.doc, a.locks, id)
  ok('lock releases on purpose', await until(() => !isLockedByOther(b.awareness, b.locks, id, b.doc.clientID)))
  ok('typing streams to peers', (() => {
    a.elements.get(id).doc.transact(() => a.elements.get(id).set('text', 'typing live'), 'edit')
    return true
  })())
  ok('live text arrives at B', await until(() => b.elements.get(id).get('text') === 'typing live'))

  console.log('\nPresence')
  a.awareness.setLocalStateField('cursor', { x: 12, y: 34 })
  ok('cursor visible to peers', await until(() => b.awareness.getStates().get(a.doc.clientID)?.cursor?.x === 12))
  ok('name visible to peers', b.awareness.getStates().get(a.doc.clientID)?.name === 'Ada')
  ok('both participants listed', b.awareness.getStates().size >= 2)

  console.log('\nDead peer frees its stickers')
  const c = peer('Alan')
  await until(() => c.ready() && a.ready())
  const note = createElement(c.doc, c.elements, c.meta, { kind: KIND.NOTE, x: 5, y: 5, text: 'mine' })
  const noteId = note.get('id')
  claimLock(c.awareness, c.doc, c.locks, noteId)
  await until(() => holderOf(a.awareness, a.locks, noteId)?.by === c.doc.clientID)
  ok('lock held by Alan shows on others', holderOf(a.awareness, a.locks, noteId)?.name === 'Alan')
  c.destroy() // hard kill: no release path runs
  ok('lock released when peer vanishes', await until(() => !isLockedByOther(a.awareness, a.locks, noteId, a.doc.clientID), { timeout: 9000 }))
  ok('B can now claim the freed sticker', claimLock(b.awareness, b.doc, b.locks, noteId))

  console.log('\nDrawing, frames and ordering')
  const stroke = createElement(b.doc, b.elements, b.meta, { kind: KIND.STROKE, x: 10, y: 10, size: 4 })
  appendPoints(stroke, [0, 0, 30, 12, 60, 0])
  finishStroke(stroke)
  const sid = stroke.get('id')
  ok('stroke replicates', await until(() => b.elements.has(sid) && a.elements.has(sid)))
  ok('stroke bounds computed', boundsOf(a.elements.get(sid)).w > 50)
  const frame = createElement(b.doc, b.elements, b.meta, { kind: KIND.FRAME, x: 0, y: 0, w: 400, h: 200 })
  ok('frame replicates', await until(() => a.elements.has(frame.get('id'))))
  ok('z counter increments', a.meta.get('z') > 0)
  // The frame was created *after* the sticker, so its raw z is higher; it must still sit below.
  const laterFrame = createElement(a.doc, a.elements, a.meta, { kind: KIND.FRAME, x: 100, y: 100, w: 300, h: 200 })
  const underNote = createElement(a.doc, a.elements, a.meta, { kind: KIND.NOTE, x: 120, y: 120, text: 'inside' })
  ok('frame paints below a sticker created earlier', stackZ(a.elements.get(frame.get('id'))) < stackZ(underNote))
  // "Bring to front" may not lift a frame over notes, whichever order they were made in.
  bringToFront(laterFrame, a.meta)
  ok('bring-to-front keeps frames under notes', stackZ(laterFrame) < stackZ(underNote))
  deleteElement(a.awareness, a.locks, a.elements, laterFrame.get('id'), a.doc.clientID)
  deleteElement(a.awareness, a.locks, a.elements, underNote.get('id'), a.doc.clientID)
  deleteElement(b.awareness, b.locks, b.elements, frame.get('id'), b.doc.clientID)
  ok('frame delete replicates', await until(() => !a.elements.has(frame.get('id'))))

  console.log('\nTitle shared')
  const title = `Retro ${Date.now()}`
  b.meta.set('title', title)
  ok('title syncs', await until(() => a.meta.get('title') === title))

  console.log('\nPersistence across restart')
  const marker = `persisted-${process.pid}`
  const mk = createElement(b.doc, b.elements, b.meta, { kind: KIND.NOTE, x: 900, y: 700, text: marker })
  await until(() => existsSync(join(DATA, `${ROOM}.bin`)) && (Date.now(), true), { timeout: 2500 })
  await wait(1500) // let the debounced save fire
  const bytes = await import('node:fs').then((fs) => fs.statSync(join(DATA, `${ROOM}.bin`)).size)
  ok('room file written to disk', bytes > 0, `(${bytes} bytes)`)
  await stopServer()
  const server2 = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', COLABFLOW_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server2.stdout.resume()
  server2.stderr.resume()
  await start()
  const d = peer('Restored')
  ok('reloaded client syncs', await until(() => d.ready()))
  ok('sticker restored after restart', await until(() => d.elements.get(mk.get('id'))?.get('text') === marker, { timeout: 5000 }))
  d.destroy()
  server2.kill('SIGTERM')
  await new Promise((r) => server2.on('exit', r))

  console.log('\nTransport hygiene')
  ok('server stayed healthy throughout', !serverLog.includes('Error'))

  a.destroy()
  b.destroy()
  if (!server.killed) await stopServer()
} catch (err) {
  failed++
  console.error('\nunexpected error:', err)
  console.error(serverLog)
} finally {
  if (!server.killed) server.kill('SIGKILL')
  try {
    if (existsSync(join(DATA, `${ROOM}.bin`))) rmSync(join(DATA, `${ROOM}.bin`))
  } catch {}
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
