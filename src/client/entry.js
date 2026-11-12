/**
 * Boot: lobby form or board session. A single `session` object holds the wired context so the
 * selection-scoped helpers (swatch visibility) can reach the board.
 */
import { Board } from './board.js'
import { Camera } from './camera.js'
import { View } from './render.js'
import { Presence } from './presence.js'
import { FRAME_COLORS, KIND, NOTE_COLORS } from './model.js'
import {
  connect, readName, writeName, roomFromUrl, rememberRoom, readRooms, watchStatus,
} from './store.js'

const $ = (sel) => document.querySelector(sel)

const NOTE_PALETTE = NOTE_COLORS
const FRAME_PALETTE = FRAME_COLORS
const INK_PALETTE = [
  { name: 'Ink', value: '#1f2430' },
  { name: 'Red', value: '#dc2626' },
  { name: 'Blue', value: '#2563eb' },
  { name: 'Green', value: '#16a34a' },
  { name: 'Orange', value: '#ea580c' },
  { name: 'Purple', value: '#7c3aed' },
]

/** @type {{board: Board, ctx: object, presence: Presence}|null} */
let session = null

/* ── lobby ──────────────────────────────────────────────────────────── */

function initLobby () {
  const nameInput = $('#name')
  const roomInput = $('#room')
  const saved = readName()
  if (saved) nameInput.value = saved

  const prefill = roomFromUrl()
  const recent = readRooms()
  if (prefill) roomInput.value = prefill
  else if (recent.length) roomInput.placeholder = recent[0].room

  if (recent.length && !prefill) {
    const list = $('#recent')
    list.hidden = false
    list.replaceChildren(
      ...recent.map(({ room, at }) => {
        const li = document.createElement('li')
        const a = document.createElement('a')
        a.href = `/r/${encodeURIComponent(room)}`
        a.textContent = room
        const when = document.createElement('span')
        when.className = 'who'
        when.textContent = new Date(at).toLocaleDateString()
        li.append(a, when)
        return li
      })
    )
  }

  $('#join').addEventListener('submit', (e) => {
    e.preventDefault()
    const name = nameInput.value.trim()
    const room = roomInput.value.trim() || recent[0]?.room || 'retro'
    if (!name) return nameInput.focus()
    writeName(name)
    location.href = `/r/${encodeURIComponent(room)}`
  })
  nameInput.addEventListener('change', () => writeName(nameInput.value.trim()))
}

/* ── board ──────────────────────────────────────────────────────────── */

function initBoard () {
  const room = decodeURIComponent(roomFromUrl() ?? 'retro')
  const name = readName() || 'Guest'
  rememberRoom(room)
  $('#roomname').textContent = `/${room}`

  const { doc, provider, stores, me, awareness } = connect(room, name)

  let toastTimer = 0
  const notify = (msg) => {
    const el = $('#lock-toast')
    el.textContent = msg
    el.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      el.hidden = true
    }, 1900)
  }

  const ctx = {
    doc,
    awareness,
    me,
    meta: stores.meta,
    locks: stores.locks,
    elements: stores.elements,
    stage: $('#stage'),
    world: $('#world'),
    elsLayer: $('#elements'),
    inkLayer: $('#ink-layer'),
    marqueeEl: $('#marquee'),
    selection: new Set(),
    editingId: null,
    activeResize: null,
    view: null,
    camera: null,
    swatchColor: () => checkedSwatch('note') ?? NOTE_PALETTE[0].value,
    frameColor: () => checkedSwatch('frame') ?? FRAME_PALETTE[0].value,
    strokeColor: () => checkedSwatch('draw') ?? INK_PALETTE[0].value,
    notify,
    onSelection: () => syncSwatches(),
  }

  const camera = new Camera(ctx.stage, ctx.world, () => {
    session?.presence?.invalidate()
    $('#zoom-label').textContent = `${Math.round(camera.scale * 100)}%`
  })
  ctx.camera = camera

  const board = new Board(ctx)
  ctx.view = new View(ctx)

  const presence = new Presence({
    layer: $('#cursors'),
    avatars: $('#avatars'),
    awareness,
    camera,
    me,
    onPeerChange: (n) => {
      $('#status').textContent = n > 1
        ? `${n} people here · scroll to pan, Ctrl+scroll to zoom`
        : 'Scroll to pan · Ctrl+scroll to zoom · Space-drag to pan'
    },
  })
  session = { board, ctx, presence }

  /* ── model -> DOM ────────────────────────────────────────────────── */

  let raf = 0
  const dirty = new Set()
  let metaDirty = false
  const flush = () => {
    raf = 0
    if (metaDirty) {
      metaDirty = false
      const t = stores.meta.get('title')
      const field = $('#title')
      if (t !== undefined && document.activeElement !== field && field.value !== t) field.value = t
      for (const id of ctx.view.nodes.keys()) dirty.add(id) // z-order may have shifted
    }
    for (const id of dirty) ctx.view.sync(id)
    dirty.clear()
  }
  const schedule = (ids, meta = false) => {
    if (ids) for (const id of ids) dirty.add(id)
    if (meta) metaDirty = true
    if (!raf) raf = requestAnimationFrame(flush)
  }

  stores.elements.observeDeep((events) => {
    for (const ev of events) {
      if (ev.target === stores.elements) {
        for (const key of ev.changes.keys.keys()) dirty.add(key)
      } else {
        const id = ev.path[0]
        if (id !== undefined) dirty.add(id)
      }
    }
    if (!raf) raf = requestAnimationFrame(flush)
  })

  // z (and title) live on meta; a change there can reorder every element.
  stores.meta.observeDeep(schedule)
  stores.locks.observe(() => schedule(ctx.view.nodes.keys()))
  awareness.on('change', () => {
    presence.render(awareness.getStates())
    schedule(ctx.view.nodes.keys())
  })
  presence.render(awareness.getStates())

  watchStatus(provider, awareness, (state, peers) => {
    const el = $('#sync')
    el.dataset.state = state
    el.textContent =
      state === 'online' ? `${peers} online` : state === 'connecting' ? 'connecting…' : 'offline — retrying'
    if (state === 'online' && !board.fitted) {
      board.fitted = true
      const bounds = board.contentBounds()
      if (bounds) camera.fit(bounds, 140)
    }
  })

  /* ── title ───────────────────────────────────────────────────────── */

  const title = $('#title')
  title.value = stores.meta.get('title') ?? 'Retrospective'
  title.addEventListener('input', () => doc.transact(() => stores.meta.set('title', title.value), 'edit'))
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') title.blur()
  })

  /* ── toolbar ─────────────────────────────────────────────────────── */

  document.querySelectorAll('#tools .tool').forEach((btn) => {
    btn.addEventListener('click', () => {
      board.setTool(btn.dataset.tool)
      syncSwatches()
      ctx.stage.focus({ preventScroll: true })
    })
  })

  const swatches = $('#swatches')
  const addSwatch = (group, color, label, active) => {
    const btn = document.createElement('button')
    btn.className = 'swatch'
    btn.type = 'button'
    btn.dataset.color = color
    btn.dataset.kinds = group
    btn.style.background = color
    btn.title = `${label} ${color}`
    btn.setAttribute('role', 'radio')
    btn.setAttribute('aria-checked', String(active))
    btn.setAttribute('aria-label', `${label} ${color}`)
    btn.addEventListener('click', () => {
      swatches.querySelectorAll(`.swatch[data-kinds="${group}"]`).forEach((o) => {
        o.setAttribute('aria-checked', 'false')
      })
      btn.setAttribute('aria-checked', 'true')
      applyColor(group, color)
    })
    swatches.append(btn)
  }
  NOTE_PALETTE.forEach((c, i) => addSwatch('note', c.value, c.name, i === 0))
  INK_PALETTE.forEach((c, i) => addSwatch('draw', c.value, c.name, i === 0))
  FRAME_PALETTE.forEach((c, i) => addSwatch('frame', c.value, c.name, i === 0))

  /* ── zoom / invite ───────────────────────────────────────────────── */

  $('#zoom-in').addEventListener('click', () => camera.zoomAroundCenter(1.2))
  $('#zoom-out').addEventListener('click', () => camera.zoomAroundCenter(1 / 1.2))
  $('#zoom-label').addEventListener('click', () => camera.setZoom(1))
  $('#zoom-fit').addEventListener('click', () => camera.fit(board.contentBounds(), 140))
  $('#zoom-label').textContent = '100%'

  $('#invite').addEventListener('click', async () => {
    const url = location.href
    let ok = false
    try {
      await navigator.clipboard.writeText(url)
      ok = true
    } catch {
      const field = $('#clipboard')
      field.value = url
      field.select()
      ok = document.execCommand?.('copy') ?? false
    }
    notify(ok ? 'Board link copied' : url)
  })

  ctx.stage.addEventListener('contextmenu', (e) => {
    if (e.button === 2) e.preventDefault()
  })

  board.setTool('select')
  ctx.view.syncAll()
  syncSwatches()

  addEventListener('beforeunload', () => provider.destroy())

  /** Colour the current selection of the matching kind. */
  function applyColor (group, color) {
    const kind = group === 'note' ? KIND.NOTE : group === 'frame' ? KIND.FRAME : KIND.STROKE
    const ids = board.unlocked([...board.selection]).filter((id) => board.elAt(id)?.get('kind') === kind)
    if (!ids.length) return syncSwatches()
    doc.transact(() => {
      for (const id of ids) board.elAt(id).set('color', color)
    }, 'local')
    ids.forEach((id) => ctx.view.sync(id))
  }
}

function checkedSwatch (group) {
  return document.querySelector(`#swatches .swatch[data-kinds="${group}"][aria-checked="true"]`)
    ?.dataset.color ?? null
}

/** Show only the palette that matches what is selected / the active tool. */
function syncSwatches () {
  const { board } = session ?? {}
  if (!board) return
  const kinds = new Set()
  for (const id of board.selection) {
    const k = board.elAt(id)?.get('kind')
    if (k) kinds.add(k)
  }
  const wanted = new Set()
  if (kinds.has(KIND.NOTE)) wanted.add('note')
  if (kinds.has(KIND.FRAME) || board.tool === 'frame') wanted.add('frame')
  if (kinds.has(KIND.STROKE) || board.tool === 'draw') wanted.add('draw')
  if (!wanted.size) wanted.add(board.tool === 'draw' ? 'draw' : board.tool === 'frame' ? 'frame' : 'note')
  document.querySelectorAll('#swatches .swatch').forEach((s) => {
    s.hidden = !wanted.has(s.dataset.kinds)
  })
}

if (location.pathname.startsWith('/r/')) initBoard()
else initLobby()
