/**
 * Pan/zoom camera. The world container is translated and scaled from these values; everything
 * the renderer positions uses unscaled world coordinates.
 */
export const MIN_SCALE = 0.15
export const MAX_SCALE = 4

export class Camera {
  /** @param {HTMLElement} stage @param {HTMLElement} world @param {function} onChange */
  constructor (stage, world, onChange) {
    this.x = 0
    this.y = 0
    this.scale = 1
    this.stage = stage
    this.world = world
    this.onChange = onChange
    this.rect = { left: 0, top: 0, width: 1, height: 1 }
    this.measure()
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => {
        this.measure()
        this.apply()
      }).observe(stage)
    } else {
      addEventListener('resize', () => {
        this.measure()
        this.apply()
      })
    }
  }

  measure () {
    this.rect = this.stage.getBoundingClientRect()
  }

  apply () {
    const { x, y, scale } = this
    this.world.style.setProperty('--ox', `${x}px`)
    this.world.style.setProperty('--oy', `${y}px`)
    this.world.style.setProperty('--scale', String(scale))
    this.stage.style.setProperty('--grid', `${26 * scale}px`)
    if (this.onChange) this.onChange()
  }

  /** Client coordinates -> stage-local coordinates. */
  local (clientX, clientY) {
    return {
      sx: clientX - this.rect.left,
      sy: clientY - this.rect.top,
    }
  }

  /** Client coordinates -> world coordinates. */
  toWorld (clientX, clientY) {
    const { sx, sy } = this.local(clientX, clientY)
    return { x: (sx - this.x) / this.scale, y: (sy - this.y) / this.scale }
  }

  /** World coordinates -> stage-local coordinates. */
  toStage (wx, wy) {
    return { x: wx * this.scale + this.x, y: wy * this.scale + this.y }
  }

  get size () {
    return { w: this.rect.width, h: this.rect.height }
  }

  panBy (dx, dy) {
    this.x += dx
    this.y += dy
    this.apply()
  }

  /** Zoom keeping the stage point (sx, sy) fixed. */
  zoomAt (sx, sy, factor) {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor))
    if (next === this.scale) return
    const wx = (sx - this.x) / this.scale
    const wy = (sy - this.y) / this.scale
    this.scale = next
    this.x = sx - wx * next
    this.y = sy - wy * next
    this.apply()
  }

  zoomAroundCenter (factor) {
    this.zoomAt(this.rect.width / 2, this.rect.height / 2, factor)
  }

  setZoom (scale) {
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
    this.zoomAt(this.rect.width / 2, this.rect.height / 2, s / this.scale)
  }

  /** Fit `bounds` (world rect) into the viewport with padding. */
  fit (bounds, pad = 80) {
    if (!bounds) return
    const w = Math.max(1, bounds.w)
    const h = Math.max(1, bounds.h)
    const scale = Math.min(
      MAX_SCALE,
      Math.min((this.rect.width - pad * 2) / w, (this.rect.height - pad * 2) / h)
    )
    this.scale = Math.max(MIN_SCALE, scale)
    this.x = (this.rect.width - w * this.scale) / 2 - bounds.x * this.scale
    this.y = (this.rect.height - h * this.scale) / 2 - bounds.y * this.scale
    this.apply()
  }
}
