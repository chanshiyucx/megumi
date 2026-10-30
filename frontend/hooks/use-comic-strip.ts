import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Image } from '@/types/library'

// Pages kept mounted (and so loaded) around the viewport, in viewports: more
// in the reading direction, so the pages coming up get the bandwidth rather
// than the ones already read.
const AHEAD_VIEWPORTS = 3
const BEHIND_VIEWPORTS = 1
const DEFAULT_MAX_RENDERED_PAGES = 16
// A page edge this close to the viewport edge counts as aligned with it.
const EDGE_SLOP = 2
// Upper bound for a smooth step scroll; after it the next step reads the real
// scroll offset again even if the animation was interrupted.
const STEP_SETTLE_MS = 800
export type ComicStripOrientation = 'horizontal' | 'vertical'

interface ComicPageLayout {
  index: number
  width: number
  height: number
  size: number
  start: number
  end: number
  center: number
}

interface ComicStripLayout {
  orientation: ComicStripOrientation
  containerWidth: number
  containerHeight: number
  totalSize: number
  viewportSize: number
  pages: ComicPageLayout[]
}

interface VisibleRange {
  start: number
  end: number
}

interface UseComicStripOptions {
  images: Image[]
  initialIndex?: number
  onCurrentIndexChange?: (index: number) => void
  orientation?: ComicStripOrientation
  maxRenderedPages?: number
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function findFirstPageEndingAfter(pages: ComicPageLayout[], value: number) {
  let low = 0
  let high = pages.length - 1
  let result = pages.length - 1

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (pages[mid].end > value) {
      result = mid
      high = mid - 1
    } else {
      low = mid + 1
    }
  }

  return result
}

function findLastPageStartingBefore(pages: ComicPageLayout[], value: number) {
  let low = 0
  let high = pages.length - 1
  let result = 0

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (pages[mid].start < value) {
      result = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return result
}

function createLayout(
  images: Image[],
  containerWidth: number,
  containerHeight: number,
  orientation: ComicStripOrientation,
): ComicStripLayout | null {
  if (!images.length || containerWidth <= 0 || containerHeight <= 0) {
    return null
  }

  let cursor = 0
  const pages = images.map((image, index) => {
    const width =
      orientation === 'horizontal'
        ? Math.max(
            1,
            Math.round(
              (containerHeight * image.width) / Math.max(1, image.height),
            ),
          )
        : containerWidth
    const height =
      orientation === 'vertical'
        ? Math.max(
            1,
            Math.round(
              (containerWidth * image.height) / Math.max(1, image.width),
            ),
          )
        : containerHeight
    const size = orientation === 'horizontal' ? width : height
    const start = cursor
    const end = start + size
    cursor = end

    return {
      index,
      width,
      height,
      size,
      start,
      end,
      center: start + size / 2,
    }
  })

  return {
    orientation,
    containerWidth,
    containerHeight,
    totalSize: cursor,
    viewportSize:
      orientation === 'horizontal' ? containerWidth : containerHeight,
    pages,
  }
}

function getComicStripCurrentIndex(
  layout: ComicStripLayout,
  scrollOffset: number,
): number {
  const { pages, viewportSize } = layout
  const viewportEnd = scrollOffset + viewportSize
  const startIndex = Math.max(
    0,
    findFirstPageEndingAfter(pages, scrollOffset) - 1,
  )
  let nearestIndex = clamp(startIndex, 0, pages.length - 1)
  let nearestDistance = Number.POSITIVE_INFINITY

  for (
    let index = startIndex;
    index < pages.length && pages[index].start < viewportEnd;
    index += 1
  ) {
    const page = pages[index]
    const visibleWidth =
      Math.min(page.end, viewportEnd) - Math.max(page.start, scrollOffset)
    const visibilityThreshold = Math.min(page.size, viewportSize) * 0.5

    if (visibleWidth >= visibilityThreshold) {
      return index
    }

    const distance = Math.abs(page.center - (scrollOffset + viewportSize / 2))
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearestIndex = index
    }
  }

  return nearestIndex
}

function getVisibleRange(
  layout: ComicStripLayout,
  scrollOffset: number,
  direction: 1 | -1,
  maxRenderedPages: number,
): VisibleRange {
  const ahead = layout.viewportSize * AHEAD_VIEWPORTS
  const behind = layout.viewportSize * BEHIND_VIEWPORTS
  const visibleStart = Math.max(
    0,
    scrollOffset - (direction > 0 ? behind : ahead),
  )
  const visibleEnd = Math.min(
    layout.totalSize,
    scrollOffset + layout.viewportSize + (direction > 0 ? ahead : behind),
  )

  // createLayout produces contiguous pages and a positive viewport, so the
  // first intersecting page cannot come after the last intersecting page.
  let start = findFirstPageEndingAfter(layout.pages, visibleStart)
  let end = findLastPageStartingBefore(layout.pages, visibleEnd)

  if (end - start + 1 > maxRenderedPages) {
    // Over the cap: keep every page in view, then split the slots left over
    // the way the overscan is split, more in the reading direction; slots one
    // side cannot use (start / end of the comic) go to the other.
    const inViewStart = findFirstPageEndingAfter(layout.pages, scrollOffset)
    const inViewEnd = findLastPageStartingBefore(
      layout.pages,
      scrollOffset + layout.viewportSize,
    )
    const spare = Math.max(0, maxRenderedPages - (inViewEnd - inViewStart + 1))
    const behindShare = Math.floor(
      (spare * BEHIND_VIEWPORTS) / (AHEAD_VIEWPORTS + BEHIND_VIEWPORTS),
    )
    const before = inViewStart - start
    const after = end - inViewEnd
    let keepBefore = Math.min(
      before,
      direction > 0 ? behindShare : spare - behindShare,
    )
    const keepAfter = Math.min(after, spare - keepBefore)
    keepBefore = Math.min(before, spare - keepAfter)
    start = inViewStart - keepBefore
    end = inViewEnd + keepAfter
  }

  return { start, end }
}

function shouldUpdateVisibleRange(
  currentRange: VisibleRange,
  nextRange: VisibleRange,
) {
  return (
    nextRange.start < currentRange.start || nextRange.end > currentRange.end
  )
}

/**
 * Where a one-page step from `offset` lands.
 *
 * Horizontal: forward brings the first page cut off by the far viewport edge
 * fully into view (its end on that edge), backward does the same for the near
 * edge; a page wider than the viewport is walked through a viewport at a time.
 *
 * Vertical: pages are usually taller than the viewport, so a step moves to the
 * next / previous page and puts its top at the top of the viewport.
 */
function getStepOffset(
  layout: ComicStripLayout,
  offset: number,
  direction: 1 | -1,
) {
  const { pages, viewportSize, totalSize } = layout
  const viewportEnd = offset + viewportSize
  const maxOffset = Math.max(0, totalSize - viewportSize)
  let target: number

  if (layout.orientation === 'vertical') {
    const page =
      direction > 0
        ? pages.find((p) => p.start > offset + EDGE_SLOP)
        : pages.findLast((p) => p.start < offset - EDGE_SLOP)
    return page ? clamp(page.start, 0, maxOffset) : null
  }

  if (direction > 0) {
    const page = pages.find((p) => p.end > viewportEnd + EDGE_SLOP)
    if (!page) return null
    target =
      page.size <= viewportSize
        ? page.end - viewportSize
        : page.start > offset + EDGE_SLOP
          ? page.start
          : Math.min(viewportEnd, page.end - viewportSize)
  } else {
    const page = pages.findLast((p) => p.start < offset - EDGE_SLOP)
    if (!page) return null
    target =
      page.size <= viewportSize
        ? page.start
        : page.end < viewportEnd - EDGE_SLOP
          ? page.end - viewportSize
          : Math.max(offset - viewportSize, page.start)
  }

  return clamp(target, 0, maxOffset)
}

/**
 * Where a jump to `index` lands: the page at the start edge, so the page the
 * strip then reports as current (the first one mostly in view) is the target.
 * Centering it left the previous page in view, which was saved instead and
 * moved the position back one page on every jump and reopen.
 */
function getJumpOffset(layout: ComicStripLayout, index: number) {
  return clamp(
    layout.pages[index].start,
    0,
    Math.max(0, layout.totalSize - layout.viewportSize),
  )
}

/**
 * Where `offset`, a scroll offset in `from`, lands in `to`: on the same page,
 * the same fraction of the way into it. A resize keeps the reader on the spot
 * they were reading instead of snapping it to the start of a page.
 */
function getAnchoredOffset(
  from: ComicStripLayout,
  to: ComicStripLayout,
  offset: number,
) {
  const page = from.pages[findFirstPageEndingAfter(from.pages, offset)]
  const target = to.pages[Math.min(page.index, to.pages.length - 1)]
  const ratio = clamp((offset - page.start) / page.size, 0, 1)
  return clamp(
    Math.round(target.start + ratio * target.size),
    0,
    Math.max(0, to.totalSize - to.viewportSize),
  )
}

function getScrollOffset(
  container: HTMLDivElement,
  orientation: ComicStripOrientation,
) {
  return orientation === 'horizontal'
    ? container.scrollLeft
    : container.scrollTop
}

export function useComicStrip({
  images,
  initialIndex = 0,
  onCurrentIndexChange,
  orientation = 'horizontal',
  maxRenderedPages = DEFAULT_MAX_RENDERED_PAGES,
}: UseComicStripOptions) {
  const containerRef = useRef<HTMLDivElement>(null)
  const pendingJumpRef = useRef<number | null>(initialIndex)
  const frameRef = useRef<number | null>(null)
  const pendingScrollOffsetRef = useRef(0)
  // Which way the reader last scrolled; reading starts forward.
  const directionRef = useRef<1 | -1>(1)
  // Destination of an in-flight smooth step, so quick repeated steps chain
  // from where the last one is heading rather than from mid-animation.
  const stepTargetRef = useRef<number | null>(null)
  const stepTimerRef = useRef<number | null>(null)
  const currentIndexRef = useRef(initialIndex)
  const visibleRangeRef = useRef<VisibleRange>({ start: 0, end: 0 })
  const layoutRef = useRef<ComicStripLayout | null>(null)
  // The layout the current scroll offset was set in, for anchoring it when
  // the layout changes.
  const scrolledLayoutRef = useRef<ComicStripLayout | null>(null)
  const onCurrentIndexChangeRef =
    useRef<UseComicStripOptions['onCurrentIndexChange']>(onCurrentIndexChange)

  const [containerSize, setContainerSize] = useState({
    width: 0,
    height: 0,
  })
  const [visibleRange, setVisibleRange] = useState<VisibleRange>({
    start: 0,
    end: 0,
  })

  const layout = useMemo(
    () =>
      createLayout(
        images,
        containerSize.width,
        containerSize.height,
        orientation,
      ),
    [containerSize.height, containerSize.width, images, orientation],
  )
  const layoutRestoreKey = `${containerSize.width}x${containerSize.height}:${orientation}:${images
    .map((image) => `${image.width}x${image.height}`)
    .join('|')}`

  useEffect(() => {
    onCurrentIndexChangeRef.current = onCurrentIndexChange
  }, [onCurrentIndexChange])

  // Layout effect, declared before the scroll-restore effect below: that effect
  // reads layoutRef.current synchronously in the same commit, so the ref must be
  // refreshed first (a passive effect lagged a commit behind, leaving the
  // initial visibleRange at {0,0} until the first scroll).
  useLayoutEffect(() => {
    layoutRef.current = layout
  }, [layout])

  const flushScrollState = () => {
    frameRef.current = null
    const scrollOffset = pendingScrollOffsetRef.current
    if (!layout) return

    const nextIndex = getComicStripCurrentIndex(layout, scrollOffset)
    if (nextIndex !== currentIndexRef.current) {
      currentIndexRef.current = nextIndex
      onCurrentIndexChangeRef.current?.(nextIndex)
    }

    const nextRange = getVisibleRange(
      layout,
      scrollOffset,
      directionRef.current,
      maxRenderedPages,
    )
    if (shouldUpdateVisibleRange(visibleRangeRef.current, nextRange)) {
      visibleRangeRef.current = nextRange
      setVisibleRange(nextRange)
    }
  }

  const onScroll = () => {
    const container = containerRef.current
    if (!container) return
    const scrollOffset = getScrollOffset(container, orientation)
    if (scrollOffset !== pendingScrollOffsetRef.current) {
      directionRef.current =
        scrollOffset > pendingScrollOffsetRef.current ? 1 : -1
    }
    pendingScrollOffsetRef.current = scrollOffset
    if (
      stepTargetRef.current !== null &&
      Math.abs(scrollOffset - stepTargetRef.current) < 1
    ) {
      stepTargetRef.current = null
    }
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(flushScrollState)
  }

  const jumpTo = (targetIndex?: number) => {
    if (!images.length) return

    const nextIndex = clamp(
      targetIndex ?? currentIndexRef.current,
      0,
      images.length - 1,
    )
    currentIndexRef.current = nextIndex

    const container = containerRef.current
    if (!container || !layout) {
      pendingJumpRef.current = nextIndex
      return
    }

    const targetOffset = getJumpOffset(layout, nextIndex)

    pendingJumpRef.current = null
    scrolledLayoutRef.current = layout
    // Reading goes on forward from wherever a jump lands, even a jump back.
    pendingScrollOffsetRef.current = targetOffset
    directionRef.current = 1
    if (orientation === 'horizontal') {
      container.scrollLeft = targetOffset
    } else {
      container.scrollTop = targetOffset
    }

    const nextRange = getVisibleRange(
      layout,
      targetOffset,
      directionRef.current,
      maxRenderedPages,
    )
    visibleRangeRef.current = nextRange
    setVisibleRange(nextRange)
  }

  const step = (direction: 1 | -1) => {
    const container = containerRef.current
    if (!container || !layout) return

    const offset =
      stepTargetRef.current ?? getScrollOffset(container, orientation)
    const target = getStepOffset(layout, offset, direction)
    if (target === null) return

    stepTargetRef.current = target
    if (stepTimerRef.current !== null) clearTimeout(stepTimerRef.current)
    stepTimerRef.current = window.setTimeout(() => {
      stepTargetRef.current = null
      stepTimerRef.current = null
    }, STEP_SETTLE_MS)

    container.scrollTo({
      [orientation === 'horizontal' ? 'left' : 'top']: target,
      behavior: 'smooth',
    })
  }

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    const updateSize = () => {
      const width = container.clientWidth
      const height = container.clientHeight
      // A hidden strip (a background tab, the library's reader on a phone)
      // measures 0. Keep the last layout: the content keeps its size, so the
      // browser keeps the scroll offset and shows the same spot again.
      if (width <= 0 || height <= 0) return
      setContainerSize((prev) =>
        prev.width === width && prev.height === height
          ? prev
          : { width, height },
      )
    }

    updateSize()

    const observer = new ResizeObserver(updateSize)
    observer.observe(container)

    return () => {
      observer.disconnect()
    }
  }, [])

  useLayoutEffect(() => {
    if (!images.length) {
      currentIndexRef.current = 0
      visibleRangeRef.current = { start: 0, end: 0 }
      pendingJumpRef.current = 0
      scrolledLayoutRef.current = null
      return
    }

    const currentLayout = layoutRef.current
    const container = containerRef.current
    if (!currentLayout || !container) return

    const previousLayout = scrolledLayoutRef.current
    scrolledLayoutRef.current = currentLayout
    let targetOffset: number
    if (pendingJumpRef.current === null && previousLayout) {
      targetOffset = getAnchoredOffset(
        previousLayout,
        currentLayout,
        pendingScrollOffsetRef.current,
      )
      // A new viewport may put another page mostly in view.
      const nextIndex = getComicStripCurrentIndex(currentLayout, targetOffset)
      if (nextIndex !== currentIndexRef.current) {
        currentIndexRef.current = nextIndex
        onCurrentIndexChangeRef.current?.(nextIndex)
      }
    } else {
      const targetIndex = pendingJumpRef.current ?? currentIndexRef.current
      const nextIndex = clamp(targetIndex, 0, images.length - 1)
      currentIndexRef.current = nextIndex
      targetOffset = getJumpOffset(currentLayout, nextIndex)
      pendingJumpRef.current = null
      // Reading goes on forward from wherever a jump lands, even a jump back.
      directionRef.current = 1
    }

    pendingScrollOffsetRef.current = targetOffset
    if (orientation === 'horizontal') {
      container.scrollLeft = targetOffset
    } else {
      container.scrollTop = targetOffset
    }

    const nextRange = getVisibleRange(
      currentLayout,
      targetOffset,
      directionRef.current,
      maxRenderedPages,
    )
    visibleRangeRef.current = nextRange
    setVisibleRange((prev) =>
      prev.start === nextRange.start && prev.end === nextRange.end
        ? prev
        : nextRange,
    )
  }, [
    images.length,
    layoutRestoreKey,
    maxRenderedPages,
    orientation,
  ])

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      if (stepTimerRef.current !== null) clearTimeout(stepTimerRef.current)
    },
    [],
  )

  return {
    containerRef,
    currentIndex: () => currentIndexRef.current,
    jumpTo,
    step,
    layout,
    onScroll,
    visibleRange,
  }
}
