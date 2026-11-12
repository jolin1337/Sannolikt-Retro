/**
 * Renderer: Y.Map elements -> DOM (notes/frames) + SVG (strokes).
 *
 * One view per element id, created lazily and reused, so a board with hundreds of elements stays
 * cheap: a change only touches the DOM of the element that changed. Geometry is applied via
 * `transform` because the shared `.el` rule anchors everything at (0,0).
 */
import { boundsOf, FRAME_DEFAULT_COLOR, KIND, NOTE_DEFAULT, NOTE_DEFAULT_COLOR, holderOf, stackZ } from './model.js'
/** Smooth a stroke into an SVG path; points are relative to the element origin. */
export function pathFromPoints (points) {
  const n = points.length
  if (n < 2) return ''
  if (n === 2) return `M${points[0]} ${points[1]}L${points[2] ?? points[0]} ${points[3] ?? points[1]}`
  let d = `M${points[0]} ${points[1]}`
  for (let i = 2; i < n - 2; i += 2) {
    const cx = points[i]
    const cy = points[i + 1]
    const nx = points[i + 2] ?? cx
    const ny = points[i + 3] ?? cy
    d += `Q${cx} ${cy} ${(cx + nx) / 2} ${(cy + ny) / 2}`
  }
  d += `L${points[n - 2]} ${points[n - 1]}`
  return d
}
/**
 * Same hue at a fixed alpha, for the translucent wash and stripes a frame paints behind its
 * notes. Anything without a parseable colour (e.g. legacy 'transparent') stays transparent.
 */
export function withAlpha (color, alpha) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color).trim())
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/(.)/g, '$1$1') : hex[1]
    const n = parseInt(h, 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
  }
  const rgb = /rgba?\(([^)]+)\)/i.exec(String(color))
  if (rgb) {
    const [r, g, b] = rgb[1].split(',').map((s) => parseFloat(s))
    if ([r, g, b].every(Number.isFinite)) return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  return 'rgba(0, 0, 0, 0)'
}

/** Blend a colour toward slate-700 so a pale frame fill still gets a readable border. */
function edge (color) {
  const base = withAlpha(color, 1)
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(base)
  const [r, g, b] = m ? [m[1], m[2], m[3]].map(Number) : [100, 116, 139]
  const mix = (c) => Math.round(c * 0.45 + 0x33 * 0.55)
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`
}
export const initials = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export class View {
  /** @param {object} ctx elements, locks, awareness, me, camera, selection, layers */
  constructor (ctx) {
    this.ctx = ctx
    /** @type {Map<string, object>} id -> view node */
    this.nodes = new Map()
    this.elsLayer = ctx.elsLayer
    this.inkLayer = ctx.inkLayer
  }

  /** Reconcile DOM with the document: create/update everything, drop what is gone. */
  syncAll () {
    const live = new Set()
    this.ctx.elements.forEach((el, id) => {
      live.add(id)
      this.sync(id)
    })
    for (const [id, node] of [...this.nodes]) {
      if (!live.has(id)) {
        node.remove()
        this.nodes.delete(id)
      }
    }
  }

  /** Create or refresh one element's DOM. */
  sync (id) {
    const el = this.ctx.elements.get(id)
    if (!el) {
      this.nodes.get(id)?.remove()
      this.nodes.delete(id)
      return
    }
    const kind = el.get('kind')
    let node = this.nodes.get(id)
    if (!node || node.kind !== kind) {
      node?.remove()
      node = this.#create(id, kind, el)
    }
    node.data = el

    if (kind === KIND.STROKE) {
      const flat = el.get('points').toArray()
      const d = pathFromPoints(flat)
      node.path.setAttribute('d', d)
      node.hit.setAttribute('d', d)
      node.g.setAttribute('transform', `translate(${el.get('x') ?? 0} ${el.get('y') ?? 0})`)
      node.path.setAttribute('stroke', el.get('color') ?? '#111827')
      node.path.setAttribute('stroke-width', String(el.get('size') ?? 3))
      node.g.classList.toggle('selected', this.#selected(id))
      return
    }

    const x = Math.round(el.get('x') ?? 0)
    const y = Math.round(el.get('y') ?? 0)
    const w = Math.round(el.get('w') ?? NOTE_DEFAULT.w)
    const h = Math.round(el.get('h') ?? NOTE_DEFAULT.h)
    node.node.style.transform = `translate3d(${x}px, ${y}px, 0)`
    node.node.style.width = `${w}px`
    node.node.style.height = `${h}px`
    node.node.style.zIndex = String(stackZ(el))
    const stored = el.get('color')
    // Frames used to default to 'transparent'; that value now reads as the palette default.
    const color = stored && stored !== 'transparent'
      ? stored
      : (kind === KIND.FRAME ? FRAME_DEFAULT_COLOR : NOTE_DEFAULT_COLOR)
    node.node.style.setProperty('--c', color)
    // Frames read as a pale wash plus soft diagonal stripes; the border is the same hue, darkened
    // so a pastel fill still has an outline that is legible against the board.
    if (kind === KIND.FRAME) {
      node.node.style.setProperty('--c-wash', withAlpha(color, 0.08))
      node.node.style.setProperty('--c-stripe', withAlpha(color, 0.16))
      node.node.style.setProperty('--c-edge', edge(color))
    }

    const field = node.text ?? node.label
    if (field) {
      const value = el.get('text') ?? ''
      // Never overwrite what a holder is currently typing; the local caret owns the field.
      if (field.value !== value && id !== this.ctx.editingId) field.value = value
      if (node.label) node.label.placeholder = 'Frame'
    }
    this.#lockState(id, node)
    node.node.classList.toggle('selected', this.#selected(id))
    const showHandles = this.#selected(id)
    for (const hEl of node.handles) hEl.hidden = !showHandles
  }

  #create (id, kind, el) {
    if (kind === KIND.STROKE) {
      const ns = 'http://www.w3.org/2000/svg'
      const g = document.createElementNS(ns, 'g')
      g.dataset.id = id
      const hit = document.createElementNS(ns, 'path')
      hit.setAttribute('class', 'stroke-hit')
      const path = document.createElementNS(ns, 'path')
      g.append(hit, path)
      this.inkLayer.append(g)
      const node = { kind, g, path, hit, data: el, remove: () => g.remove() }
      this.nodes.set(id, node)
      return node
    }

    const node = document.createElement('div')
    node.className = `el ${kind}`
    node.dataset.id = id
    if (kind === KIND.NOTE) {
      const text = document.createElement('textarea')
      text.className = 'note-text'
      text.spellcheck = false
      text.readOnly = true
      text.value = el.get('text') ?? ''
      text.setAttribute('aria-label', 'Sticker text')
      const meta = document.createElement('div')
      meta.className = 'note-meta'
      const by = document.createElement('span')
      by.className = 'by'
      by.textContent = el.get('authorName') ?? ''
      meta.append(by)
      node.append(text, meta)
    } else {
      const label = document.createElement('input')
      label.className = 'frame-label'
      label.spellcheck = false
      label.readOnly = true
      label.value = el.get('text') ?? ''
      label.placeholder = 'Frame'
      label.setAttribute('aria-label', 'Frame name')
      node.append(label)
    }
    node.insertAdjacentHTML(
      'beforeend',
      '<span class="lock-badge" hidden></span><span class="remote-caret" hidden></span>' +
      '<i class="resize nw" data-dir="nw"></i><i class="resize ne" data-dir="ne"></i>' +
      '<i class="resize sw" data-dir="sw"></i><i class="resize se" data-dir="se"></i>'
    )
    this.elsLayer.append(node)
    const view = {
      kind,
      node,
      data: el,
      text: kind === KIND.NOTE ? node.querySelector('.note-text') : null,
      label: kind === KIND.FRAME ? node.querySelector('.frame-label') : null,
      badge: node.querySelector('.lock-badge'),
      caret: node.querySelector('.remote-caret'),
      handles: [...node.querySelectorAll('.resize')],
      remove: () => node.remove(),
    }
    this.nodes.set(id, view)
    return view
  }

  #selected (id) {
    return this.ctx.selection.has(id)
  }

  /** Reflect the live edit lock: badge with holder, caret for remote typing, read-only fields. */
  #lockState (id, node) {
    const { awareness, locks, me } = this.ctx
    const holder = holderOf(awareness, locks, id)
    const field = node.text ?? node.label
    const mine = !holder || holder.by === me.id
    // Locked by someone else: disabled so it cannot even take focus, styled unchanged.
    if (field) {
      field.disabled = !mine
      field.readOnly = id !== this.ctx.editingId
    }
    if (!holder) {
      if (node.badge) node.badge.hidden = true
      if (node.caret) node.caret.hidden = true
      node.node.classList.remove('locked')
      node.node.style.removeProperty('--holder')
      return
    }
    node.node.classList.toggle('locked', !mine)
    node.node.style.setProperty('--holder', holder.color ?? '#d97706')
    if (node.badge) {
      node.badge.hidden = false
      node.badge.textContent = mine ? 'you are editing' : `${holder.name || 'Someone'} editing`
    }
    if (node.caret) {
      const st = awareness.getStates().get(holder.by)
      const editing = st?.editing
      const show = !mine && editing && editing.id === id
      node.caret.hidden = !show
      const spot = show ? (editing.caret ?? st?.cursor) : null
      if (spot) {
        const local = this.toLocal(node.data, spot)
        node.caret.style.left = `${Math.round(local.x)}px`
        node.caret.style.top = `${Math.round(local.y)}px`
      }
    }
    if (field) field.readOnly = !mine || id !== this.ctx.editingId
  }

  /** Element-local coordinates of a world point. */
  toLocal (el, world) {
    return { x: world.x - (el.get('x') ?? 0), y: world.y - (el.get('y') ?? 0) }
  }

  /** Selection visuals for the given ids. */
  repaint (ids) {
    for (const id of ids) {
      const node = this.nodes.get(id)
      if (!node) continue
      const on = this.#selected(id)
      if (node.g) node.g.classList.toggle('selected', on)
      else {
        node.node.classList.toggle('selected', on)
        for (const h of node.handles) h.hidden = !on
      }
    }
  }

  /** Hit test in world space; the topmost element id or null. */
  hitTest (wx, wy) {
    const scale = this.ctx.camera.scale
    const pad = 4 / scale
    let best = null
    this.ctx.elements.forEach((el, id) => {
      const kind = el.get('kind')
      const b = boundsOf(el)
      let inside
      if (kind === KIND.STROKE) {
        inside = distToPolyline(el, wx, wy) <= (el.get('size') ?? 3) / 2 + 10 / scale
      } else if (kind === KIND.FRAME) {
        inside =
          wx >= b.x - pad && wx <= b.x + b.w + pad && wy >= b.y - pad && wy <= b.y + b.h + pad &&
          !(wx > b.x + pad && wx < b.x + b.w - pad && wy > b.y + pad && wy < b.y + b.h - pad)
      } else {
        inside = wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h
      }
      if (!inside) return
      if (!best || stackZ(el) > best.z) best = { id, z: stackZ(el) }
    })
    return best?.id ?? null
  }
}

/** Distance from a world point to a stroke's world-space polyline. */
function distToPolyline (el, wx, wy) {
  const ox = el.get('x') ?? 0
  const oy = el.get('y') ?? 0
  const pts = el.get('points')
  const n = pts.length
  if (n < 2) return Infinity
  let min = Infinity
  for (let i = 0; i < n - 2; i += 2) {
    const ax = ox + pts[i]
    const ay = oy + pts[i + 1]
    const bx = ox + pts[i + 2]
    const by = oy + pts[i + 3]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((wx - ax) * dx + (wy - ay) * dy) / len2))
    min = Math.min(min, Math.hypot(wx - (ax + dx * t), wy - (ay + dy * t)))
  }
  return min
}
