import { useEffect, useEffectEvent, useState, type RefObject } from 'react'

export interface ParagraphSelection {
  // Paragraph (line) indices touched by the selection, in order.
  lines: number[]
  // Anchor point for the floating button, relative to the container.
  x: number
  y: number
  // Touch devices put the button under the selection, clear of the system
  // copy menu that appears above it.
  placeBelow: boolean
}

const BUTTON_EDGE_MARGIN = 48

function lineElementOf(node: Node) {
  const element = node instanceof Element ? node : node.parentElement
  return element?.closest<HTMLElement>('[data-line-index]') ?? null
}

/**
 * Tracks the text selection inside `containerRef` as whole paragraphs: any
 * paragraph the selection touches counts, however little of it is selected.
 * Paragraph elements carry `data-line-index`; `isSelectable` filters out lines
 * that cannot be favorited (illustrations).
 */
export function useParagraphSelection(
  containerRef: RefObject<HTMLElement | null>,
  isSelectable: (lineIndex: number) => boolean,
) {
  const [selection, setSelection] = useState<ParagraphSelection | null>(null)

  const read = useEffectEvent((): ParagraphSelection | null => {
    const container = containerRef.current
    const current = document.getSelection()
    if (!container || !current || !current.rangeCount || current.isCollapsed) {
      return null
    }
    const range = current.getRangeAt(0)
    if (!container.contains(range.commonAncestorContainer)) return null

    const startElement = lineElementOf(range.startContainer)
    const endElement = lineElementOf(range.endContainer)
    if (!startElement || !endElement) return null

    const start = Number(startElement.dataset.lineIndex)
    let end = Number(endElement.dataset.lineIndex)
    if (end > start) {
      // A selection that stops at the very start of a paragraph (triple-click,
      // or dragging just past a line end) does not include that paragraph.
      const probe = document.createRange()
      probe.setStart(endElement, 0)
      probe.setEnd(range.endContainer, range.endOffset)
      if (!probe.toString()) end -= 1
    }

    const lines: number[] = []
    for (let line = start; line <= end; line += 1) {
      if (isSelectable(line)) lines.push(line)
    }
    if (!lines.length) return null

    const rect = range.getBoundingClientRect()
    const box = container.getBoundingClientRect()
    const placeBelow = window.matchMedia('(pointer: coarse)').matches
    const edge = placeBelow ? rect.bottom : rect.top
    return {
      lines,
      x: Math.min(
        Math.max(rect.left + rect.width / 2 - box.left, BUTTON_EDGE_MARGIN),
        box.width - BUTTON_EDGE_MARGIN,
      ),
      // Keep the button inside the reader when the selection runs off-screen.
      y: Math.min(Math.max(edge - box.top, BUTTON_EDGE_MARGIN), box.height - BUTTON_EDGE_MARGIN),
      placeBelow,
    }
  })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let frame: number | null = null
    const schedule = () => {
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        setSelection(read())
      })
    }

    document.addEventListener('selectionchange', schedule)
    // Scroll events do not bubble; capture the reader's inner scroller so the
    // button follows the selection.
    container.addEventListener('scroll', schedule, true)
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', schedule)
      container.removeEventListener('scroll', schedule, true)
    }
  }, [containerRef])

  const clear = () => {
    document.getSelection()?.removeAllRanges()
    setSelection(null)
  }

  return { selection, clear }
}
