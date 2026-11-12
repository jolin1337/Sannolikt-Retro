/**
 * Live presence: other participants' cursors with their name, plus the avatar stack.
 *
 * Presence rides on Awareness only; nothing about it is persisted.
 */
const ARROW = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
<path d="M2 2l14 6.5-6.4 1.6L7.6 17z" fill="currentColor" stroke="#fff" stroke-width="1.2"/>
</svg>`

const CURSOR_SMOOTH_MS = 90
const GONE_MS = 4000

export class Presence {
  /**
   * @param {object} o  { layer, avatars, awareness, camera, me, onPeerChange }
   */
  constructor ({ layer, avatars, awareness, camera, me, onPeerChange }) {
    this.layer = layer
    this.avatars = avatars
    this.awareness = awareness
    this.camera = camera
    this.me = me
    this.onPeerChange = onPeerChange
    /** @type {Map<number, {node, target, last, color, name, timer}>} */
    this.nodes = new Map()
    this.raf = 0
  }

  /** @param {Map<number, object>} states */
  render (states) {
    const seen = new Set()
    for (const [clientId, state] of states) {
      if (clientId === this.me.id) continue
      seen.add(clientId)
      const color = state.color ?? '#64748b'
      const name = state.name ?? 'Guest'
      let entry = this.nodes.get(clientId)
      if (!entry) {
        const node = document.createElement('div')
        node.className = 'cursor'
        node.style.color = color
        node.innerHTML = `${ARROW}<span class="tag"></span>`
        this.layer.append(node)
        entry = { node, tag: node.querySelector('.tag'), target: null, last: 0, color, name }
        this.nodes.set(clientId, entry)
      }
      entry.color = color
      entry.name = name
      entry.node.style.setProperty('--c', color)
      entry.tag.textContent = name
      entry.tag.style.background = color
      entry.node.classList.toggle('typing', !!state.editing)
      if (state.cursor) {
        entry.target = state.cursor
        entry.last = Date.now()
      }
      if (!state.cursor) entry.target = null
    }
    for (const [clientId, entry] of [...this.nodes]) {
      if (seen.has(clientId)) continue
      entry.node.remove()
      this.nodes.delete(clientId)
    }
    this.avail()
    this.draw()
    if (!this.raf) this.raf = requestAnimationFrame(() => this.step())
  }

  /** Rebuild the avatar stack in the header. */
  avail () {
    const states = this.awareness.getStates()
    const peers = []
    for (const [id, s] of states) {
      if (id === this.me.id) continue
      if (peers.some((p) => p.id === id)) continue
      peers.push({ id, name: s.name ?? 'Guest', color: s.color ?? '#64748b' })
    }
    const you = [{ id: this.me.id, name: `${this.me.name} (you)`, color: this.me.color, you: true }]
    const all = [...you, ...peers.sort((a, b) => a.name.localeCompare(b.name))]
    const frag = document.createDocumentFragment()
    for (const p of all) {
      const el = document.createElement('span')
      el.className = `av${p.you ? ' you' : ''}`
      el.dataset.remote = p.you ? '0' : '1'
      el.title = p.name
      el.style.background = p.color
      el.textContent = initials(p.name)
      frag.append(el)
    }
    this.avatars.replaceChildren(frag)
    this.onPeerChange?.(peers.length + 1)
  }

  step () {
    this.raf = 0
    const changed = this.draw()
    if (this.nodes.size) this.raf = requestAnimationFrame(() => this.step())
    void changed
  }

  /** Place cursors, interpolating toward the last known world position. */
  draw () {
    let any = false
    for (const entry of this.nodes.values()) {
      if (!entry.target) {
        entry.node.style.display = 'none'
        continue
      }
      entry.node.style.display = ''
      const p = this.camera.toStage(entry.target.x, entry.target.y)
      entry.node.style.setProperty('--x', `${Math.round(p.x)}px`)
      entry.node.style.setProperty('--y', `${Math.round(p.y)}px`)
      any = true
    }
    return any
  }

  /** Camera moved: place immediately, no interpolation. */
  invalidate () {
    this.draw()
  }

  dispose () {
    if (this.raf) cancelAnimationFrame(this.raf)
    for (const entry of this.nodes.values()) entry.node.remove()
    this.nodes.clear()
  }
}

export const initials = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

void CURSOR_SMOOTH_MS
void GONE_MS
