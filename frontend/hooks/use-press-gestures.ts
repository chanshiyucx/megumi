import { useEffect, useRef, type PointerEvent } from 'react'

const DOUBLE_MS = 350 // max gap between the two taps of a double-tap
const LONG_PRESS_MS = 500 // a press held this long is a long press, not a tap
const TAP_SLOP = 16 // a press may wiggle this much and still be a "tap"
const GAP_SLOP = 40 // the two taps may land this far apart

export interface Press {
  // 'mouse', 'pen' or 'touch': surfaces answer a mouse and a finger differently.
  pointerType: string
  x: number
  y: number
  target: EventTarget
}

interface PressGestures {
  onTap?: (press: Press) => void
  onDoubleTap?: (press: Press) => void
  // Touch and pen only: a mouse held down is still a click.
  onLongPress?: (press: Press) => void
  // Whether this tap may still become a double tap. One that cannot fires at
  // once instead of waiting DOUBLE_MS; by default every tap may when
  // onDoubleTap is set.
  canDoubleTap?: (press: Press) => boolean
}

// Spread onto a child (e.g. an overlaid button) that handles its own tap and
// must not let the parent's press gestures, which ride these events, also fire.
export const stopPointerProps = {
  onPointerDown: (e: PointerEvent) => {
    e.stopPropagation()
  },
  onPointerUp: (e: PointerEvent) => {
    e.stopPropagation()
  },
}

/**
 * Which third of `rect` a press lands in along the reading axis: -1 for the
 * start (left / top), 1 for the end, 0 for the middle.
 */
export function pressZone(
  rect: DOMRect,
  press: Press,
  axis: 'horizontal' | 'vertical',
): -1 | 0 | 1 {
  const ratio =
    axis === 'horizontal'
      ? (press.x - rect.left) / rect.width
      : (press.y - rect.top) / rect.height
  if (ratio < 1 / 3) return -1
  if (ratio > 2 / 3) return 1
  return 0
}

function toPress(e: PointerEvent): Press {
  return {
    pointerType: e.pointerType,
    x: e.clientX,
    y: e.clientY,
    target: e.target,
  }
}

/**
 * Tap, double-tap and long press from one pointer handler, for mouse and touch
 * alike. When both tap and double-tap are wanted a single tap is held back by
 * `DOUBLE_MS` to see whether a second tap turns it into a double.
 */
export function usePressGestures({
  onTap,
  onDoubleTap,
  onLongPress,
  canDoubleTap,
}: PressGestures) {
  const down = useRef({ x: 0, y: 0 })
  const lastTap = useRef({ time: 0, x: 0, y: 0 })
  const tapTimer = useRef<number | null>(null)
  const longPressTimer = useRef<number | null>(null)
  // The press already fired as a long press, so its release is not a tap.
  const longPressed = useRef(false)

  const clearTap = () => {
    if (tapTimer.current !== null) {
      clearTimeout(tapTimer.current)
      tapTimer.current = null
    }
  }
  const clearLongPress = () => {
    if (longPressTimer.current !== null) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }

  useEffect(
    () => () => {
      clearTap()
      clearLongPress()
    },
    [],
  )

  const onPointerDown = (e: PointerEvent) => {
    down.current = { x: e.clientX, y: e.clientY }
    longPressed.current = false
    clearLongPress()
    if (onLongPress && e.pointerType !== 'mouse') {
      const press = toPress(e)
      longPressTimer.current = window.setTimeout(() => {
        longPressTimer.current = null
        longPressed.current = true
        onLongPress(press)
      }, LONG_PRESS_MS)
    }
  }

  const onPointerMove = (e: PointerEvent) => {
    if (
      Math.abs(e.clientX - down.current.x) > TAP_SLOP ||
      Math.abs(e.clientY - down.current.y) > TAP_SLOP
    ) {
      clearLongPress()
    }
  }

  const onPointerUp = (e: PointerEvent) => {
    clearLongPress()
    if (longPressed.current) {
      longPressed.current = false
      return
    }
    // A drag/swipe travelled too far to count as a tap.
    if (
      Math.abs(e.clientX - down.current.x) > TAP_SLOP ||
      Math.abs(e.clientY - down.current.y) > TAP_SLOP
    ) {
      lastTap.current = { time: 0, x: 0, y: 0 }
      return
    }

    const press = toPress(e)
    if (onDoubleTap && canDoubleTap && !canDoubleTap(press)) {
      clearTap()
      lastTap.current = { time: 0, x: 0, y: 0 }
      onTap?.(press)
      return
    }

    const prev = lastTap.current
    const quick = e.timeStamp - prev.time < DOUBLE_MS
    const near =
      Math.abs(e.clientX - prev.x) < GAP_SLOP &&
      Math.abs(e.clientY - prev.y) < GAP_SLOP

    if (onDoubleTap && quick && near) {
      clearTap()
      lastTap.current = { time: 0, x: 0, y: 0 }
      onDoubleTap(press)
      return
    }

    lastTap.current = { time: e.timeStamp, x: e.clientX, y: e.clientY }
    if (!onTap) return
    if (!onDoubleTap) {
      onTap(press)
      return
    }
    clearTap()
    tapTimer.current = window.setTimeout(() => {
      tapTimer.current = null
      onTap(press)
    }, DOUBLE_MS)
  }

  const onPointerCancel = () => {
    clearLongPress()
    longPressed.current = false
  }

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel }
}
