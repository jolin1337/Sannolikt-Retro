/**
 * Shared document model.
 *
 * y.getMap('meta')     { title, z, schema, createdAt }
 * y.getMap('elements') id -> Y.Map  (kind: note | frame | stroke)
 * y.getMap('locks')    id -> Y.Map(claimantClientID -> claimedAt)
 *
 * A lock entry names the holder's Y.Doc clientID, which is also the key into the Awareness state
 * map. A claim is therefore only live while its claimant still appears in Awareness: a peer that
 * vanished (closed tab, killed browser, dropped link) stops holding its stickers as soon as the
 * server reports the awareness removal, without waiting for a timeout.
 */
import * as Y from 'yjs'

export const SCHEMA = 1
export const KIND = { NOTE: 'note', FRAME: 'frame', STROKE: 'stroke' }

export const NOTE_COLORS = [
  { name: 'Yellow', value: '#fef08a' },
  { name: 'Green', value: '#bbf7d0' },
  { name: 'Blue', value: '#bfdbfe' },
  { name: 'Pink', value: '#fbcfe8' },
  { name: 'Purple', value: '#ddd6fe' },
  { name: 'Orange', value: '#fed7aa' },
  { name: 'Grey', value: '#e5e7eb' },
]

/** Frame fills stay pale: a frame sits behind notes, so only its border reads at full strength. */
export const FRAME_COLORS = [
  { name: 'Slate', value: '#94a3b8' },
  { name: 'Blue', value: '#bfdbfe' },
  { name: 'Green', value: '#bbf7d0' },
  { name: 'Yellow', value: '#fef08a' },
  { name: 'Pink', value: '#fbcfe8' },
  { name: 'Purple', value: '#ddd6fe' },
]
/** First swatch of each palette: what an element created without a colour gets. */
export const NOTE_DEFAULT_COLOR = NOTE_COLORS[0].value
export const FRAME_DEFAULT_COLOR = FRAME_COLORS[0].value
export const PRESENCE_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4',
  '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f43f5e',
]

/** Stable hue for a name, salted by clientID so two people may differ. */
export const colorFor = (name, salt = 0) => {
  let h = salt >>> 0
  for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) >>> 0
  return PRESENCE_COLORS[h % PRESENCE_COLORS.length]
}

export const NOTE_DEFAULT = { w: 208, h: 148, minW: 120, minH: 96 }
export const FRAME_DEFAULT = { w: 560, h: 360, minW: 200, minH: 160 }

/**
 * Paint/hit order. `z` alone orders by creation time, which would let a frame drawn last cover
 * every sticker inside it, so frames get a band of their own below notes and strokes.
 */
const Z_STRIDE = 1 << 20
export const stackZ = (el) => (el.get('kind') === KIND.FRAME ? -Z_STRIDE : 0) + (el.get('z') ?? 0)

export const id = () =>
  (crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  ).replace(/-/g, '')

/** @returns {{meta: Y.Map<any>, elements: Y.Map<Y.Map<any>>, locks: Y.Map<any>}} */
export function bindStores (doc) {
  const meta = doc.getMap('meta')
  const elements = doc.getMap('elements')
  const locks = doc.getMap('locks')
  if (meta.get('schema') === undefined) {
    doc.transact(() => {
      meta.set('schema', SCHEMA)
      meta.set('z', 0)
      meta.set('title', 'Retrospective')
      meta.set('createdAt', Date.now())
    }, 'init')
  }
  return { meta, elements, locks }
}

const nextZ = (meta) => {
  const z = (meta.get('z') ?? 0) + 1
  meta.set('z', z)
  return z
}

/**
 * Create an element.
 *
 * The empty Y.Map is inserted into `elements` *before* any of its fields are written. Filling a
 * preliminary (not yet integrated) container — especially one holding a nested Y.Array — leaves
 * items with an undefined parentSub and makes `encodeStateAsUpdate` throw, which would break
 * persistence and sync. Integrating first inside one transaction keeps creation atomic.
 *
 * @param {Y.Doc} doc
 * @param {Y.Map<Y.Map<any>>} elements
 * @param {Y.Map<any>} meta
 * @param {object} o  kind, x, y, w?, h?, text?, color?, size?, authorName?, id?
 * @returns {Y.Map<any>}
 */
export function createElement (doc, elements, meta, o) {
  const newId = o.id ?? id()
  const el = new Y.Map()
  const points = o.kind === KIND.STROKE ? new Y.Array() : null
  doc.transact(() => {
    elements.set(newId, el)
    el.set('id', newId)
    el.set('kind', o.kind)
    el.set('x', Math.round(o.x ?? 0))
    el.set('y', Math.round(o.y ?? 0))
    el.set('w', Math.round(o.w ?? (o.kind === KIND.FRAME ? FRAME_DEFAULT.w : NOTE_DEFAULT.w)))
    el.set('h', Math.round(o.h ?? (o.kind === KIND.FRAME ? FRAME_DEFAULT.h : NOTE_DEFAULT.h)))
    el.set('z', nextZ(meta))
    el.set('author', doc.clientID)
    el.set('authorName', o.authorName ?? '')
    el.set('createdAt', Date.now())
    if (points) el.set('points', points)
    if (o.kind === KIND.NOTE) {
      el.set('text', o.text ?? '')
      el.set('color', o.color ?? NOTE_COLORS[0].value)
    } else if (o.kind === KIND.FRAME) {
      el.set('text', o.text ?? 'Frame')
      el.set('color', o.color ?? FRAME_COLORS[0].value)
    } else if (o.kind === KIND.STROKE) {
      el.set('text', '')
      el.set('color', o.color ?? '#111827')
      el.set('size', o.size ?? 3)
    }
  }, 'create')
  return el
}

/** Append [x, y, x, y, ...] to a stroke, in one transaction so observers see a batch. */
export const appendPoints = (el, flat) => {
  const points = el.get('points')
  el.doc.transact(() => points.push(Array.isArray(flat) ? flat : [flat]), 'local')
}

/**
 * Stroke points are relative to the element origin, so a stroke moves by editing x/y alone. The
 * origin is the first captured point, so the polyline can extend into negative coordinates.
 */
const strokeExtent = (el) => {
  const pts = el.get('points')
  if (!pts || pts.length === 0) return null
  let minX = 0
  let minY = 0
  let maxX = 0
  let maxY = 0
  pts.forEach((v, i) => {
    if (i % 2 === 0) {
      if (v < minX) minX = v
      if (v > maxX) maxX = v
    } else {
      if (v < minY) minY = v
      if (v > maxY) maxY = v
    }
  })
  const pad = (el.get('size') ?? 3) / 2 + 2
  return {
    x: (el.get('x') ?? 0) + minX - pad,
    y: (el.get('y') ?? 0) + minY - pad,
    w: maxX - minX + pad * 2,
    h: maxY - minY + pad * 2,
  }
}

export const boundsOf = (el) => {
  if (el.get('kind') !== KIND.STROKE) {
    return { x: el.get('x') ?? 0, y: el.get('y') ?? 0, w: el.get('w') ?? 0, h: el.get('h') ?? 0 }
  }
  return strokeExtent(el) ?? { x: el.get('x') ?? 0, y: el.get('y') ?? 0, w: 0, h: 0 }
}

/** Persist a stroke's extent so hit testing needs no point scan. */
export const finishStroke = (el) => {
  const b = strokeExtent(el)
  if (!b) return
  el.doc.transact(() => {
    el.set('w', Math.max(1, Math.round(b.w)))
    el.set('h', Math.max(1, Math.round(b.h)))
  }, 'create')
}

/* ── per-element edit lock ───────────────────────────────────────── */

/**
 * Locks live as `elId -> Y.Map(claimantClientID -> claimedAt)`. One entry per claimant (rather
 * than a single record a later claim overwrites) lets simultaneous claims coexist in the CRDT
 * while every replica derives the same winner from identical state: earliest claim, ties broken by
 * clientID. Exactly one person can hold a sticker.
 */
const entriesOf = (locks, elId) => {
  const m = locks.get(elId)
  return m instanceof Y.Map ? m : null
}

/** @returns {boolean} true while `by` is a live awareness participant */
export const isLive = (awareness, by) => awareness.getStates().has(by)

export const lockOf = (locks, elId) => entriesOf(locks, elId)

/** Winner among live claimants: earliest `claimedAt`, then lowest clientID. */
const winnerOf = (awareness, entries) => {
  const live = []
  entries.forEach((at, key) => {
    const by = Number(key)
    if (typeof at === 'number' && Number.isFinite(by) && isLive(awareness, by)) live.push({ by, at })
  })
  if (!live.length) return null
  live.sort((a, b) => a.at - b.at || (a.by < b.by ? -1 : 1))
  return live[0]
}

/** The live holder, or null when the only claimants have left. */
export const holderOf = (awareness, locks, elId) => {
  const entries = entriesOf(locks, elId)
  if (!entries) return null
  const win = winnerOf(awareness, entries)
  if (!win) return null
  const st = awareness.getStates().get(win.by)
  return { by: win.by, name: st?.name ?? 'Someone', color: st?.color, at: win.at }
}

export const isLockedByOther = (awareness, locks, elId, myClientId) => {
  const h = holderOf(awareness, locks, elId)
  return h && h.by !== myClientId ? h : null
}

/**
 * Claim the exclusive edit lock. The claim is written, then verified against the computed winner;
 * a claim that is not the winner is rolled back so losers never leave stale entries. This is what
 * makes "only one person can edit a sticker at a time" hold even when two people click at the
 * same moment.
 */
export function claimLock (awareness, doc, locks, elId) {
  const by = doc.clientID
  const claimedAt = Date.now()
  let entries = entriesOf(locks, elId)
  doc.transact(() => {
    if (!entries) {
      entries = new Y.Map()
      locks.set(elId, entries)
    }
    entries.set(String(by), claimedAt)
    // Claims left behind by participants who are gone cannot resurface later.
    const dead = []
    entries.forEach((at, key) => {
      if (!isLive(awareness, Number(key))) dead.push(key)
    })
    for (const key of dead) entries.delete(key)
  }, 'local')

  const now = entriesOf(locks, elId)
  const win = now ? winnerOf(awareness, now) : null
  if (win && win.by === by) return true
  doc.transact(() => {
    const e = entriesOf(locks, elId)
    if (e && e.get(String(by)) === claimedAt) e.delete(String(by))
  }, 'local')
  return false
}

/** Give up our claim; the lock map entry disappears once nobody holds it. */
export function releaseLock (awareness, doc, locks, elId) {
  const entries = entriesOf(locks, elId)
  if (!entries || !entries.has(String(doc.clientID))) return
  doc.transact(() => {
    const e = entriesOf(locks, elId)
    if (!e) return
    e.delete(String(doc.clientID))
    // Prune claimants that are no longer present.
    const dead = []
    e.forEach((at, key) => {
      if (!isLive(awareness, Number(key))) dead.push(key)
    })
    for (const key of dead) e.delete(key)
    if (e.size === 0) locks.delete(elId)
  }, 'local')
}
/**
 * Delete an element, provided nobody else alive holds it. `by` is the requester's clientID: a
 * single claim held by the requester is theirs to give up, so editing a sticker never prevents
 * deleting it. Any other live claimant blocks the delete.
 */
export function deleteElement (awareness, locks, elements, elId, by) {
  const holder = holderOf(awareness, locks, elId)
  if (holder && holder.by !== by) return false
  elements.doc.transact(() => {
    if (locks.has(elId)) locks.delete(elId)
    elements.delete(elId)
  }, 'delete')
  return true
}

export const bringToFront = (el, meta) => {
  if (el instanceof Y.Map) el.doc.transact(() => el.set('z', nextZ(meta)), 'local')
}
