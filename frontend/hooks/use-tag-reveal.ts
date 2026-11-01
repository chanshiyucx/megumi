import { useRef, useState, type PointerEvent } from 'react'
import { useClickOutside } from '@/hooks/use-click-outside'
import { usePressGestures, type Press } from '@/hooks/use-press-gestures'

/**
 * Whether a mouse (or pen) is over the element. Touch never hovers: a finger
 * reveals tags its own way (long press, or a tap zone on the reader).
 */
export function useMouseHover() {
  const [hovered, setHovered] = useState(false)
  const hoverProps = {
    onPointerEnter: (e: PointerEvent) => {
      if (e.pointerType !== 'touch') setHovered(true)
    },
    onPointerLeave: (e: PointerEvent) => {
      if (e.pointerType !== 'touch') setHovered(false)
    },
  }
  return { hovered, hoverProps }
}

interface TagRevealOptions {
  onTap?: (press: Press) => void
  // Reveal the tag controls: on hover with a mouse, or by a long press with a
  // finger (which a press outside, or another long press, collapses). A tap
  // is left to the surface either way.
  reveal?: boolean
}

/**
 * Tag reveal for a thumbnail: returns `open` for its tag controls and the
 * `gestures` to spread on it, attached through `ref`.
 */
export function useTagReveal({
  onTap,
  reveal = false,
}: TagRevealOptions) {
  const ref = useRef<HTMLElement>(null)
  const [pressed, setPressed] = useState(false)
  const { hovered, hoverProps } = useMouseHover()
  const close = () => {
    setPressed(false)
  }

  useClickOutside(ref, close, pressed)

  const press = usePressGestures({
    onTap,
    onLongPress: reveal
      ? () => {
          setPressed((v) => !v)
        }
      : undefined,
  })
  return {
    ref,
    open: reveal && (pressed || hovered),
    gestures: { ...press, ...(reveal ? hoverProps : {}) },
    close,
  }
}
