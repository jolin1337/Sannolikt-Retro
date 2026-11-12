/**
 * Pointer and keyboard interactions: tools, drag, resize, marquee, freehand drawing, pan/zoom,
 * per-element edit locking and the clipboard.
 *
 * Every mutation another user could observe is issued under a named transaction origin, so the
 * UndoManager only ever reverts our own work, never a teammate's.
 */
import * as Y from 'yjs'
import {
  KIND, NOTE_DEFAULT, FRAME_DEFAULT,
  createElement, appendPoints, finishStroke, boundsOf,
  claimLock, releaseLock, holderOf, deleteElement, bringToFront,
} from './model.js'
import { pathFromPoints } from './render.js'

const CLICK_SLOP = 3 // px before a press counts as a drag
const CURSOR_THROTTLE = 45 // ms between presence cursor publishes
const DRAW_MIN_DIST = 1.5 // world units between pushed stroke points
const DRAW_FLUSH_MS = 55 // ms between awareness stroke pushes
const NUDGE = 8

export class Board {
  constructor (ctx) {
    this.ctx = ctx
    /** Mutated in place so `ctx.selection` stays the renderer's single source of truth. */
    this.selection = ctx.selection = new Set()
    this.tool = 'select'
    this.mode = 'idle' // idle | pan | drag | resize | marquee | draw | create
    this.editingId = null
    this.spaceDown = false
    this.pointer = { x: 0, y: 0 }
    this.clipboard = null
    this.fitted = false
    this.undo = new Y.UndoManager(ctx.elements, {
      trackedOrigins: new Set(['local', 'edit', 'create', 'paste', 'delete', 'move']),
      captureTimeout: 400,
    })
    this.lastCursorSend = 0
    this.lastDrawFlush = 0
    this.bind()
  }

  /* ── accessors ─────────────────────────────────────────────────── */

  get el () { return this.ctx.elements }
  get locks () { return this.ctx.locks }
  get doc () { return this.ctx.doc }
  get me () { return this.ctx.me }
  get awareness () { return this.ctx.awareness }
  get camera () { return this.ctx.camera }
  get view () { return this.ctx.view }
  get stage () { return this.ctx.stage }

  elAt (id) { return this.el.get(id) ?? null }
  nodeOf (id) { return this.view.nodes.get(id) ?? null }

  /** True when nobody alive holds `id`, or we do. */
  free (id) {
    const h = holderOf(this.awareness, this.locks, id)
    return !h || h.by === this.me.id
  }

  unlocked (ids) { return ids.filter((id) => this.free(id)) }

  /** A live holder that is not us, or null. */
  otherHolder (id) {
    const h = holderOf(this.awareness, this.locks, id)
    return h && h.by !== this.me.id ? h : null
  }

  notify (msg) { this.ctx.notify(msg) }

  /** One hint per attempt: say who owns what we tried to change. */
  refuse (ids) {
    const holder = this.otherHolder(ids[0])
    this.notify(holder ? `${holder.name || 'Someone'} is editing this` : 'Locked by another participant')
  }

  /* ── selection / tools ─────────────────────────────────────────── */

  setTool (tool) {
    if (this.tool === tool) return
    this.tool = tool
    this.stage.dataset.tool = tool
    document.querySelectorAll('#tools .tool').forEach((b) => {
      b.classList.toggle('active', b.dataset.tool === tool)
    })
    if (tool !== 'select') this.setSelection([])
    this.ctx.onSelection?.([...this.selection])
  }

  setSelection (ids) {
    const next = ids.filter((id) => this.el.has(id))
    const changed = next.length !== this.selection.size || next.some((id) => !this.selection.has(id))
    this.selection.clear()
    for (const id of next) this.selection.add(id)
    if (changed) this.view.repaint([...next])
    this.ctx.onSelection?.(next)
  }

  /* ── locks ─────────────────────────────────────────────────────── */

  /** Claim the exclusive edit lock. False (with a hint) when somebody else holds it. */
  claim (id, quiet = false) {
    const holder = this.otherHolder(id)
    if (holder) {
      if (!quiet) this.notify(`${holder.name || 'Someone'} is editing this`)
      return false
    }
    const ok = claimLock(this.awareness, this.doc, this.locks, id)
    if (!ok) {
      const after = this.otherHolder(id)
      if (!quiet) this.notify(after ? `${after.name || 'Someone'} got there first` : 'Could not lock this element')
      return false
    }
    this.view.sync(id)
    return true
  }

  release (id) {
    releaseLock(this.awareness, this.doc, this.locks, id)
    if (this.el.has(id)) this.view.sync(id)
  }

  /* ── text editing ──────────────────────────────────────────────── */

  enterEdit (id, selectAll = false) {
    if (this.editingId === id) return
    if (this.editingId) this.exitEdit()
    const el = this.elAt(id)
    if (!el || el.get('kind') === KIND.STROKE) return
    if (!this.claim(id)) return
    const node = this.nodeOf(id)
    const field = node?.text ?? node?.label
    if (!field) return
    this.editingId = id
    this.ctx.editingId = id
    field.readOnly = false
    field.focus()
    if (selectAll) field.select()
    else field.setSelectionRange(field.value.length, field.value.length)
    this.publishEditing()
    this.view.sync(id)
  }

  exitEdit () {
    const id = this.editingId
    if (!id) return
    this.editingId = null
    this.ctx.editingId = null
    const node = this.nodeOf(id)
    const field = node?.text ?? node?.label
    if (field) {
      if (document.activeElement === field) field.blur()
      field.readOnly = true
    }
    this.awareness.setLocalStateField('editing', null)
    this.release(id)
    if (this.el.has(id)) this.view.sync(id)
  }

  publishEditing () {
    if (!this.editingId) return
    this.awareness.setLocalStateField('editing', {
      id: this.editingId,
      caret: caretFromField(this.elAt(this.editingId), this.fieldCaret()),
    })
  }

  fieldCaret () {
    const node = this.nodeOf(this.editingId)
    const field = node?.text ?? node?.label
    return field ? { value: field.value, pos: field.selectionStart ?? 0 } : { value: '', pos: 0 }
  }

  onTextInput (id, value) {
    const el = this.elAt(id)
    if (!el) return
    if (this.otherHolder(id)) {
      // A peer's lock beat ours mid-edit: hand the element back rather than fighting.
      this.notify('Edit taken over by another participant')
      this.exitEdit()
      return
    }
    // Y.Map.set ignores a trailing origin; use a transaction so undo can capture the text.
    this.doc.transact(() => el.set('text', value), 'edit')
    this.publishEditing()
  }

  /* ── geometry ──────────────────────────────────────────────────── */

  /**
   * Place elements at absolute world coordinates. Locked ids are skipped and, unless `quiet`,
   * announced once. Returns true when at least one element moved.
   */
  place (entries, quiet = false) {
    const targets = entries.filter((e) => this.free(e.id))
    if (!targets.length) {
      if (!quiet) this.refuse(entries.map((e) => e.id))
      return false
    }
    if (targets.length !== entries.length && !quiet) this.refuse(entries.map((e) => e.id))
    this.doc.transact(() => {
      for (const { id, x, y } of targets) {
        const el = this.elAt(id)
        if (!el) continue
        el.set('x', Math.round(x))
        el.set('y', Math.round(y))
      }
    }, 'move')
    return true
  }

  moveBy (ids, dx, dy) {
    return this.place(ids.map((id) => {
      const el = this.elAt(id)
      return { id, x: (el.get('x') ?? 0) + dx, y: (el.get('y') ?? 0) + dy }
    }))
  }

  boundsOfSelected () {
    const ids = [...this.selection]
    return union(ids, (id) => {
      const el = this.elAt(id)
      return el ? boundsOf(el) : null
    })
  }

  contentBounds () {
    return union([...this.el.keys()], (id) => boundsOf(this.elAt(id)))
  }

  /** Create an element, optionally seeded with fields. */
  create (kind, rect, extra = {}) {
    const minW = kind === KIND.FRAME ? FRAME_DEFAULT.minW : NOTE_DEFAULT.minW
    const minH = kind === KIND.FRAME ? FRAME_DEFAULT.minH : NOTE_DEFAULT.minH
    const el = createElement(this.doc, this.el, this.ctx.meta, {
      kind,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.max(minW, Math.round(rect.w)),
      h: Math.max(minH, Math.round(rect.h)),
      color: kind === KIND.NOTE
        ? this.ctx.swatchColor()
        : kind === KIND.FRAME
          ? this.ctx.frameColor()
          : undefined,
      authorName: this.me.name,
      ...extra,
    })
    this.view.sync(el.get('id'))
    return el
  }

  /* ── freehand ──────────────────────────────────────────────────── */

  startStroke (world) {
    const el = createElement(this.doc, this.el, this.ctx.meta, {
      kind: KIND.STROKE,
      x: Math.round(world.x),
      y: Math.round(world.y),
      color: this.ctx.strokeColor(),
      size: 3,
      authorName: this.me.name,
    })
    const id = el.get('id')
    appendPoints(el, [0, 0])
    claimLock(this.awareness, this.doc, this.locks, id)
    this.mode = 'draw'
    this.drawId = id
    this.drawOrigin = { x: world.x, y: world.y }
    this.pending = []
    this.setSelection([id])
    this.view.sync(id)
  }

  extendStroke (world) {
    const el = this.elAt(this.drawId)
    if (!el) return
    const dx = world.x - this.drawOrigin.x
    const dy = world.y - this.drawOrigin.y
    if (Math.hypot(dx, dy) < DRAW_MIN_DIST) return
    this.drawOrigin = { x: world.x, y: world.y }
    this.pending.push(Math.round(dx * 10) / 10, Math.round(dy * 10) / 10)
    // Paint locally first so the pen feels immediate, then batch to the network.
    const flat = el.get('points').toArray().concat(this.pending)
    const node = this.nodeOf(this.drawId)
    if (node) {
      const d = pathFromPoints(flat)
      node.path.setAttribute('d', d)
      node.hit.setAttribute('d', d)
    }
    const now = performance.now()
    if (now - this.lastDrawFlush >= DRAW_FLUSH_MS) {
      appendPoints(el, this.pending)
      this.pending = []
      this.lastDrawFlush = now
    }
  }

  endStroke () {
    const id = this.drawId
    this.drawId = null
    if (!id) return
    const el = this.elAt(id)
    if (this.pending?.length) {
      appendPoints(el, this.pending)
      this.pending = []
    }
    if (el) {
      // Points always start with the [0, 0] origin; anything more was real movement.
      if (el.get('points').length <= 2) {
        deleteElement(this.awareness, this.locks, this.el, id, this.me.id)
        this.view.nodes.delete(id)
        this.setSelection([])
      } else {
        finishStroke(el)
        this.view.sync(id)
      }
    }
    this.release(id)
  }

  /* ── clipboard ─────────────────────────────────────────────────── */

  serialize (ids) {
    const out = []
    for (const id of ids) {
      const el = this.elAt(id)
      if (!el) continue
      const kind = el.get('kind')
      if (kind === KIND.STROKE) {
        // Points are stored relative to the origin; export them in world space so a paste can
        // be anchored anywhere.
        const ox = el.get('x') ?? 0
        const oy = el.get('y') ?? 0
        const points = el.get('points').toArray().map((v, i) => Math.round(v + (i % 2 ? oy : ox)))
        const b = boundsOf(el)
        out.push({ kind, x: b.x, y: b.y, w: b.w, h: b.h, points, color: el.get('color'), size: el.get('size') })
      } else {
        out.push({
          kind,
          x: el.get('x') ?? 0,
          y: el.get('y') ?? 0,
          w: el.get('w'),
          h: el.get('h'),
          text: el.get('text') ?? '',
          ...(kind === KIND.NOTE ? { color: el.get('color') } : {}),
        })
      }
    }
    return out.length ? out : null
  }

  copy () {
    const ids = [...this.selection]
    if (!ids.length) return false
    const items = this.serialize(ids)
    this.clipboard = items
    const payload = JSON.stringify({ colabflow: 1, items })
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(payload).catch(() => {})
    const field = document.getElementById('clipboard')
    if (field) {
      field.value = payload
      field.select()
    }
    this.notify(`${ids.length} element${ids.length > 1 ? 's' : ''} copied`)
    return true
  }

  /** Paste `items` so their shared top-left lands on `anchor`. */
  pasteItems (items, anchor) {
    if (!Array.isArray(items) || !items.length) return 0
    const minX = Math.min(...items.map((i) => i.x ?? 0))
    const minY = Math.min(...items.map((i) => i.y ?? 0))
    const created = []
    this.doc.transact(() => {
      for (const it of items) {
        const dx = anchor.x - minX
        const dy = anchor.y - minY
        if (it.kind === KIND.STROKE) {
          const pts = (it.points ?? []).map((v, i) => v + (i % 2 ? dy : dx))
          const ox = Math.round(pts[0] ?? 0)
          const oy = Math.round(pts[1] ?? 0)
          const el = createElement(this.doc, this.el, this.ctx.meta, {
            kind: KIND.STROKE, x: ox, y: oy, color: it.color, size: it.size, authorName: this.me.name,
          })
          appendPoints(el, pts.map((v, i) => (i % 2 ? v - oy : v - ox)))
          finishStroke(el)
          created.push(el.get('id'))
        } else {
          const el = createElement(this.doc, this.el, this.ctx.meta, {
            kind: it.kind ?? KIND.NOTE,
            x: Math.round((it.x ?? 0) + dx),
            y: Math.round((it.y ?? 0) + dy),
            w: it.w,
            h: it.h,
            text: it.text ?? '',
            color: it.kind === KIND.FRAME ? 'transparent' : it.color,
            authorName: this.me.name,
          })
          created.push(el.get('id'))
        }
      }
    }, 'paste')
    created.forEach((id) => this.view.sync(id))
    this.setSelection(created)
    return created.length
  }

  duplicate (ids) {
    const items = this.serialize(ids)
    const b = union(ids, (id) => {
      const el = this.elAt(id)
      return el ? boundsOf(el) : null
    })
    if (!items || !b) return
    const n = this.pasteItems(items, { x: b.x + 20, y: b.y + 20 })
    if (n) this.notify(`Duplicated ${n} element${n > 1 ? 's' : ''}`)
  }

  /* ── delete / order ────────────────────────────────────────────── */

  deleteSelected () {
    const ids = [...this.selection]
    if (!ids.length) return
    const blocked = ids.filter((id) => !this.free(id))
    const ok = ids.filter((id) => this.free(id))
    if (!ok.length) return this.refuse(blocked)
    if (this.editingId && ok.includes(this.editingId)) this.exitEdit()
    this.doc.transact(() => {
      for (const id of ok) {
        deleteElement(this.awareness, this.locks, this.el, id, this.me.id)
        this.view.nodes.get(id)?.remove()
        this.view.nodes.delete(id)
      }
    }, 'delete')
    this.setSelection(blocked)
    this.notify(
      blocked.length ? `${ok.length} deleted · ${blocked.length} kept (locked)` : `${ok.length} deleted`
    )
  }

  bringForward (ids) {
    const target = this.unlocked(ids)
    if (!target.length) return this.refuse(ids)
    this.doc.transact(() => target.forEach((id) => bringToFront(this.elAt(id), this.ctx.meta)), 'local')
    target.forEach((id) => this.view.sync(id))
  }

  /* ── bindings ──────────────────────────────────────────────────── */

  bind () {
    this.stage.addEventListener('pointerdown', (e) => this.onPointerDown(e))
    addEventListener('pointermove', (e) => this.onPointerMove(e))
    addEventListener('pointerup', (e) => this.onPointerUp(e))
    addEventListener('pointercancel', () => this.cancel())
    addEventListener('keydown', (e) => this.onKeyDown(e))
    addEventListener('keyup', (e) => this.onKeyUp(e))
    addEventListener('blur', () => {
      this.spaceDown = false
      this.stage.classList.remove('panning')
    })
    addEventListener('paste', (e) => this.onPaste(e))
    this.stage.addEventListener('wheel', (e) => this.onWheel(e), { passive: false })
    this.stage.addEventListener('dblclick', (e) => this.onDblClick(e))

    // Fields live inside elements; delegate so new elements need no rebinding.
    this.stage.addEventListener('input', (e) => {
      const node = e.target.closest?.('.el')
      if (node && e.target.matches('.note-text, .frame-label')) {
        this.onTextInput(node.dataset.id, e.target.value)
      }
    })
    this.stage.addEventListener('focusout', (e) => {
      const node = e.target.closest?.('.el')
      if (node && this.editingId === node.dataset.id) this.exitEdit()
    })
    // Caret moved without a text change (arrow keys, click) — still worth publishing.
    this.stage.addEventListener('keyup', (e) => {
      if (!this.editingId || e.target.closest?.('.el')?.dataset.id !== this.editingId) return
      this.publishEditing()
    })
    this.stage.addEventListener('mouseup', (e) => {
      const node = e.target.closest?.('.el')
      if (node?.dataset.id === this.editingId) this.publishEditing()
    })
    // A non-holder must not be able to place a caret inside a locked element.
    this.stage.addEventListener('mousedown', (e) => {
      const node = e.target.closest?.('.el')
      if (node && !this.free(node.dataset.id)) e.preventDefault()
    })
    // Focusing a field is what takes the lock, so it also works with Tab rather than only on
    // double-click. A field disabled by a peer's lock cannot fire this at all.
    this.stage.addEventListener('focusin', (e) => {
      const node = e.target.closest?.('.el')
      if (!node || !e.target.matches('.note-text, .frame-label')) return
      const id = node.dataset.id
      if (this.editingId === id) return
      if (!this.free(id)) {
        this.refuse([id])
        e.target.blur()
        return
      }
      this.enterEdit(id)
    })
    this.stage.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && this.editingId && e.target.closest?.('.el')) this.exitEdit()
    })
  }

  /**
   * Element under a pointer. DOM first (fast, exact for notes/frames), then geometry so strokes
   * — which live in a pointer-inert SVG layer — and frame borders are still reachable.
   */
  hitId (e, world) {
    const dom = e.target?.closest?.('.el, g[data-id]')?.dataset?.id
    if (dom) return dom
    return this.view.hitTest(world.x, world.y)
  }

  resizeDir (e) {
    return e.target?.closest?.('.resize')?.dataset.dir ?? null
  }

  /* ── pointer ───────────────────────────────────────────────────── */

  onPointerDown (e) {
    if (e.button === 2) return
    this.stage.focus({ preventScroll: true })
    if (e.button === 0 && this.spaceDown) return this.beginPan(e)
    const world = this.camera.toWorld(e.clientX, e.clientY)

    const id = this.hitId(e, world)
    const field = e.target?.closest?.('.note-text, .frame-label')
    const dir = this.resizeDir(e)

    // Typing in our own element: let the caret land.
    if (id && field && this.editingId === id) return
    if (e.button !== 0) {
      if (id && !this.selection.has(id)) this.setSelection([id])
      return
    }

    // Only the select tool grabs what is under the pointer. Drawing or creating must work
    // from anywhere, even straight on top of existing elements.
    if (this.tool === 'select') {
      if (dir && id) {
        if (!this.free(id)) return this.refuse([id])
        return this.beginResize(e, id, dir)
      }
      if (id && !field) {
        if (!this.selection.has(id)) this.setSelection([id])
        return this.beginDrag(e, id)
      }
      if (field) return // unlocked field: normal text interaction
      return this.beginMarquee(e)
    }
    if (this.tool === 'draw') return this.beginDraw(world)
    return this.beginCreate(e)
  }

  beginPan (e) {
    this.mode = 'pan'
    this.pan = { x: e.clientX, y: e.clientY, ox: this.camera.x, oy: this.camera.y }
    this.stage.classList.add('panning')
  }

  beginDrag (e, id) {
    const ids = this.selection.has(id) ? [...this.selection] : [id]
    this.mode = 'drag'
    this.drag = {
      origin: { x: e.clientX, y: e.clientY },
      starts: ids.map((elId) => {
        const el = this.elAt(elId)
        return { id: elId, x: el.get('x') ?? 0, y: el.get('y') ?? 0 }
      }),
      moved: false,
    }
    this.nodeOf(id)?.node?.classList.add('dragging')
  }

  beginResize (e, id, dir) {
    const el = this.elAt(id)
    this.mode = 'resize'
    this.resize = {
      id,
      dir,
      origin: { x: e.clientX, y: e.clientY },
      box: { x: el.get('x'), y: el.get('y'), w: el.get('w'), h: el.get('h') },
    }
    this.ctx.activeResize = { id, dir }
  }

  beginMarquee (e) {
    this.mode = 'marquee'
    this.marquee = {
      x0: e.clientX,
      y0: e.clientY,
      add: e.shiftKey || e.metaKey || e.ctrlKey,
      base: e.shiftKey ? [...this.selection] : [],
    }
    if (e.shiftKey) this.setSelection(this.marquee.base)
    else this.setSelection([])
    this.showMarquee(e.clientX, e.clientY)
  }

  beginDraw (world) {
    this.startStroke(world)
  }

  beginCreate (e) {
    const kind = this.tool === 'note' ? KIND.NOTE : KIND.FRAME
    const p = this.camera.toWorld(e.clientX, e.clientY)
    const rect = kind === KIND.NOTE
      ? { x: p.x - NOTE_DEFAULT.w / 2, y: p.y - NOTE_DEFAULT.h / 2, w: NOTE_DEFAULT.w, h: NOTE_DEFAULT.h }
      : { x: p.x, y: p.y, w: 0, h: 0 }
    const el = this.create(kind, rect, kind === KIND.FRAME ? { text: '' } : {})
    const id = el.get('id')
    this.creating = { kind, origin: p, id }
    this.mode = 'create'
    this.setSelection([id])
    this.claim(id, true)
  }

  showMarquee (clientX, clientY) {
    const r = this.stage.getBoundingClientRect()
    const x = clientX - r.left
    const y = clientY - r.top
    const x0 = this.marquee.x0 - r.left
    const y0 = this.marquee.y0 - r.top
    const m = this.ctx.marqueeEl
    m.hidden = false
    m.style.left = `${Math.min(x, x0)}px`
    m.style.top = `${Math.min(y, y0)}px`
    m.style.width = `${Math.abs(x - x0)}px`
    m.style.height = `${Math.abs(y - y0)}px`
  }

  onPointerMove (e) {
    const p = this.camera.toWorld(e.clientX, e.clientY)
    this.pointer = p
    this.publishCursor(p)

    switch (this.mode) {
      case 'pan': {
        this.camera.x = this.pan.ox + e.clientX - this.pan.x
        this.camera.y = this.pan.oy + e.clientY - this.pan.y
        this.camera.apply()
        break
      }
      case 'drag': {
        if (
          !this.drag.moved &&
          Math.hypot(e.clientX - this.drag.origin.x, e.clientY - this.drag.origin.y) < CLICK_SLOP
        ) break
        this.drag.moved = true
        const dx = (e.clientX - this.drag.origin.x) / this.camera.scale
        const dy = (e.clientY - this.drag.origin.y) / this.camera.scale
        // Absolute placement from the press-time positions: no drift, and a peer's move of the
        // same element still wins by last-write-wins per coordinate.
        this.place(this.drag.starts.map((s) => ({ id: s.id, x: s.x + dx, y: s.y + dy })), true)
        this.drag.hinted = true
        break
      }
      case 'resize':
        this.applyResize(e)
        break
      case 'marquee': {
        this.showMarquee(e.clientX, e.clientY)
        const a = this.camera.toWorld(this.marquee.x0, this.marquee.y0)
        const box = {
          x: Math.min(a.x, p.x),
          y: Math.min(a.y, p.y),
          w: Math.abs(p.x - a.x),
          h: Math.abs(p.y - a.y),
        }
        const sel = []
        this.el.forEach((el, id) => {
          const b = boundsOf(el)
          if (b.x < box.x + box.w && b.x + b.w > box.x && b.y < box.y + box.h && b.y + b.h > box.y) sel.push(id)
        })
        this.setSelection(this.marquee.add ? [...this.marquee.base, ...sel] : sel)
        break
      }
      case 'draw': {
        // Include coalesced moves so fast strokes keep their shape instead of becoming chords.
        const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null
        if (coalesced && coalesced.length > 1) {
          for (const ev of coalesced) this.extendStroke(this.camera.toWorld(ev.clientX, ev.clientY))
        } else {
          this.extendStroke(p)
        }
        break
      }
      case 'create':
        this.growCreation(p)
        break
      default:
        break
    }
  }

  growCreation (p) {
    const el = this.elAt(this.creating.id)
    if (!el) return
    const x = Math.min(this.creating.origin.x, p.x)
    const y = Math.min(this.creating.origin.y, p.y)
    const w = Math.abs(p.x - this.creating.origin.x)
    const h = Math.abs(p.y - this.creating.origin.y)
    if (w < 6 && h < 6) return
    const isFrame = this.creating.kind === KIND.FRAME
    const minW = isFrame ? FRAME_DEFAULT.minW : NOTE_DEFAULT.minW
    const minH = isFrame ? FRAME_DEFAULT.minH : NOTE_DEFAULT.minH
    this.doc.transact(() => {
      el.set('x', Math.round(x))
      el.set('y', Math.round(y))
      el.set('w', Math.round(Math.max(minW, w)))
      el.set('h', Math.round(Math.max(minH, h)))
    }, 'create')
    this.view.sync(this.creating.id)
  }

  applyResize (e) {
    const { id, dir, origin, box } = this.resize
    const el = this.elAt(id)
    if (!el) return
    if (!this.free(id)) {
      this.refuse([id])
      return
    }
    const dx = (e.clientX - origin.x) / this.camera.scale
    const dy = (e.clientY - origin.y) / this.camera.scale
    const isFrame = el.get('kind') === KIND.FRAME
    const minW = isFrame ? FRAME_DEFAULT.minW : NOTE_DEFAULT.minW
    const minH = isFrame ? FRAME_DEFAULT.minH : NOTE_DEFAULT.minH
    let { x, y, w, h } = box
    if (dir.includes('e')) w = box.w + dx
    if (dir.includes('s')) h = box.h + dy
    if (dir.includes('w')) {
      w = box.w - dx
      x = box.x + dx
    }
    if (dir.includes('n')) {
      h = box.h - dy
      y = box.y + dy
    }
    if (w < minW) {
      if (dir.includes('w')) x = box.x + box.w - minW
      w = minW
    }
    if (h < minH) {
      if (dir.includes('n')) y = box.y + box.h - minH
      h = minH
    }
    if (e.shiftKey) {
      const ratio = box.w / box.h
      if (w / h > ratio) w = h * ratio
      else h = w / ratio
    }
    this.doc.transact(() => {
      el.set('x', Math.round(x))
      el.set('y', Math.round(y))
      el.set('w', Math.round(w))
      el.set('h', Math.round(h))
    }, 'move')
    this.view.sync(id)
  }

  onPointerUp () {
    const mode = this.mode
    this.stage.classList.remove('panning')
    switch (mode) {
      case 'drag': {
        const first = this.drag.starts[0]
        this.nodeOf(first?.id)?.node?.classList.remove('dragging')
        if (!this.drag.moved) {
          if (first) this.setSelection([first.id])
        } else if (this.drag.hinted) {
          const blocked = this.drag.starts.filter((s) => !this.free(s.id))
          if (blocked.length) this.refuse(blocked.map((b) => b.id))
        }
        this.drag = null
        break
      }
      case 'resize':
        this.ctx.activeResize = null
        this.view.sync(this.resize.id)
        this.resize = null
        break
      case 'marquee': {
        const m = this.ctx.marqueeEl
        m.hidden = true
        m.style.width = '0'
        m.style.height = '0'
        this.marquee = null
        break
      }
      case 'create': {
        const { kind, id } = this.creating
        this.creating = null
        const el = this.elAt(id)
        this.mode = 'idle'
        if (el) {
          if (kind === KIND.FRAME && (el.get('w') < FRAME_DEFAULT.minW || el.get('h') < FRAME_DEFAULT.minH)) {
            this.doc.transact(() => {
              el.set('w', FRAME_DEFAULT.w)
              el.set('h', FRAME_DEFAULT.h)
            }, 'create')
          }
          this.setSelection([id])
          this.enterEdit(id, true)
          return
        }
        break
      }
      case 'draw':
        this.endStroke()
        break
      default:
        break
    }
    this.mode = 'idle'
  }

  cancel () {
    if (this.mode === 'draw') this.endStroke()
    if (this.mode === 'create' && this.creating) {
      const id = this.creating.id
      deleteElement(this.awareness, this.locks, this.el, id, this.me.id)
      this.view.nodes.get(id)?.remove()
      this.view.nodes.delete(id)
      this.creating = null
    }
    this.mode = 'idle'
    this.drag = null
    this.resize = null
    this.marquee = null
    this.stage.classList.remove('panning')
    this.ctx.marqueeEl.hidden = true
  }

  onWheel (e) {
    const r = this.stage.getBoundingClientRect()
    e.preventDefault()
    const step = e.deltaMode === 1 ? 16 : 1
    if (e.ctrlKey || e.metaKey) {
      this.camera.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * step * 0.01))
    } else {
      this.camera.panBy(-e.deltaX * step, -e.deltaY * step)
    }
  }

  onDblClick (e) {
    const world = this.camera.toWorld(e.clientX, e.clientY)
    const id = this.hitId(e, world)
    if (id) {
      this.setSelection([id])
      this.enterEdit(id)
      return
    }
    if (this.mode !== 'idle' || this.tool !== 'select') return
    const el = this.create(KIND.NOTE, {
      x: world.x - NOTE_DEFAULT.w / 2,
      y: world.y - NOTE_DEFAULT.h / 2,
      w: NOTE_DEFAULT.w,
      h: NOTE_DEFAULT.h,
    })
    this.setSelection([el.get('id')])
    this.mode = 'idle'
    this.enterEdit(el.get('id'), true)
  }

  /* ── keyboard ──────────────────────────────────────────────────── */

  get typing () {
    const a = document.activeElement
    if (!a) return false
    const t = a.tagName
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || a.isContentEditable
  }

  onKeyDown (e) {
    const inField = this.typing
    if (e.key === ' ' && !inField) {
      e.preventDefault()
      this.spaceDown = true
      return
    }
    if (e.key === 'Escape') {
      if (this.editingId) this.exitEdit()
      else if (this.tool !== 'select') this.setTool('select')
      else this.setSelection([])
      return
    }
    const mod = e.ctrlKey || e.metaKey

    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      if (this.editingId) return // let the field undo its own text
      e.preventDefault()
      this.undo.undo()
      this.afterHistory()
      return
    }
    if ((mod && e.key.toLowerCase() === 'y') || (mod && e.shiftKey && e.key.toLowerCase() === 'z')) {
      if (this.editingId) return
      e.preventDefault()
      this.undo.redo()
      this.afterHistory()
      return
    }
    if (mod && e.key.toLowerCase() === 'a') {
      if (inField) return
      e.preventDefault()
      this.setSelection([...this.el.keys()])
      return
    }
    if (mod && e.key.toLowerCase() === 'c') {
      if (inField) return
      e.preventDefault()
      this.copy()
      return
    }
    if (mod && e.key.toLowerCase() === 'd') {
      if (inField || !this.selection.size) return
      e.preventDefault()
      this.duplicate([...this.selection])
      return
    }
    if (mod) return
    if (inField) return

    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      this.deleteSelected()
      return
    }
    if (e.key === 'Enter' || e.key === 'F2') {
      const ids = [...this.selection]
      if (ids.length === 1) {
        e.preventDefault()
        this.enterEdit(ids[0])
      }
      return
    }
    if (e.key === '=' || e.key === '+') return this.camera.zoomAroundCenter(1.2)
    if (e.key === '-' || e.key === '_') return this.camera.zoomAroundCenter(1 / 1.2)
    if (e.key === '0') return this.camera.setZoom(1)
    if (e.key === '1') return this.camera.fit(this.contentBounds(), 140)

    const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    if (dirs[e.key] && this.selection.size) {
      e.preventDefault()
      const ids = this.unlocked([...this.selection])
      if (!ids.length) return this.refuse([...this.selection])
      const step = e.altKey ? 1 : NUDGE
      this.place(ids.map((id) => {
        const el = this.elAt(id)
        return { id, x: (el.get('x') ?? 0) + dirs[e.key][0] * step, y: (el.get('y') ?? 0) + dirs[e.key][1] * step }
      }), true)
      return
    }
    const tools = { v: 'select', n: 'note', f: 'frame', d: 'draw' }
    const tool = tools[e.key.toLowerCase()]
    if (tool) return this.setTool(tool)
    if (e.key.toLowerCase() === 'b') return this.bringForward([...this.selection])
  }

  onKeyUp (e) {
    if (e.key === ' ') {
      this.spaceDown = false
      if (this.mode === 'pan') this.mode = 'idle'
    }
  }

  afterHistory () {
    this.view.syncAll()
    this.setSelection([...this.selection].filter((id) => this.el.has(id)))
  }

  /* ── presence ──────────────────────────────────────────────────── */

  publishCursor (p) {
    const now = performance.now()
    if (now - this.lastCursorSend < CURSOR_THROTTLE) return
    this.lastCursorSend = now
    this.awareness.setLocalStateField('cursor', {
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
    })
  }

  onPaste (e) {
    if (this.editingId) return // text paste inside a field
    const text = e.clipboardData?.getData('text/plain')
    let handled = false
    if (text) {
      try {
        const parsed = JSON.parse(text)
        if (parsed.colabflow === 1 && Array.isArray(parsed.items)) {
          const n = this.pasteItems(parsed.items, this.pointer)
          this.notify(`Pasted ${n} element${n > 1 ? 's' : ''}`)
          handled = true
        }
      } catch {
        const p = this.pointer
        const el = this.create(KIND.NOTE, {
          x: p.x - NOTE_DEFAULT.w / 2,
          y: p.y - NOTE_DEFAULT.h / 2,
          w: NOTE_DEFAULT.w,
          h: NOTE_DEFAULT.h,
          text,
        })
        this.setSelection([el.get('id')])
        handled = true
      }
    }
    if (!handled && this.clipboard) {
      const n = this.pasteItems(this.clipboard, this.pointer)
      if (n) this.notify(`Pasted ${n} element${n > 1 ? 's' : ''}`)
    }
  }
}

/** Union of element bounds, or null. */
function union (ids, get) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const id of ids) {
    const b = get(id)
    if (!b) continue
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w)
    maxY = Math.max(maxY, b.y + b.h)
  }
  if (!Number.isFinite(minX)) return null
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
}

/** World position of a text caret, estimated from the characters before it. */
function caretFromField (el, { value, pos }) {
  if (!el) return { x: 0, y: 0 }
  const w = el.get('w') ?? NOTE_DEFAULT.w
  const fs = 15
  const lineH = fs * 1.35
  const upto = String(value).slice(0, Math.max(0, pos))
  const lines = upto.split('\n')
  const line = lines.length - 1
  const perLine = Math.max(1, Math.floor((w - 26) / (fs * 0.52)))
  const x = (el.get('x') ?? 0) + 13 + Math.min(lines[line].length, perLine) * fs * 0.52
  const y = (el.get('y') ?? 0) + 13 + line * lineH
  return { x: Math.round(x), y: Math.round(y) }
}
