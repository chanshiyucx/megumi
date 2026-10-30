import { forwardRef, memo, useImperativeHandle, useState } from 'react'
import { ScrollImage } from '@/components/ui/image-view'
import {
  useComicStrip,
  type ComicStripOrientation,
} from '@/hooks/use-comic-strip'
import {
  pressZone,
  usePressGestures,
  type Press,
} from '@/hooks/use-press-gestures'
import { cn } from '@/lib/style'
import type { FileTags, Image } from '@/types/library'

export interface ComicStripHandle {
  // The page the strip is on: the one it last reported, or is jumping to.
  currentIndex: () => number
  jumpTo: (index?: number) => void
  // Smoothly moves one page forward (1) or back (-1); see getStepOffset.
  step: (direction: 1 | -1) => void
}

interface ComicStripProps {
  comicId: string
  images: Image[]
  initialIndex?: number
  orientation?: ComicStripOrientation
  className?: string
  onCurrentIndexChange?: (index: number) => void
  onHover?: (index: number | null) => void
  onDoubleClick?: (index: number) => void
  onTags: (id: string, imageKey: string, tags: FileTags) => Promise<void>
}

interface StripPageProps {
  comicId: string
  image: Image
  orientation: ComicStripOrientation
  start: number
  width: number
  height: number
  // In view: its image loads ahead of the pages preloaded around it.
  inView: boolean
  revealed: boolean
  onHover?: (index: number | null) => void
  onTags: (id: string, imageKey: string, tags: FileTags) => Promise<void>
}

// memo even with the compiler: a scroll that moves the rendered range
// rebuilds the page list, and pages already on screen should not render again.
const StripPage = memo(function StripPage({
  comicId,
  image,
  orientation,
  start,
  width,
  height,
  inView,
  revealed,
  onHover,
  onTags,
}: StripPageProps) {
  return (
    <div
      data-page-index={image.index}
      className={cn(
        'absolute',
        orientation === 'horizontal' ? 'top-0 h-full' : 'left-0 w-full',
      )}
      style={{
        left: orientation === 'horizontal' ? start : 0,
        top: orientation === 'vertical' ? start : 0,
        width,
        height,
      }}
      onMouseEnter={() => onHover?.(image.index)}
      onMouseLeave={() => onHover?.(null)}
    >
      <ScrollImage
        comicId={comicId}
        image={image}
        className="h-full w-full"
        fetchPriority={inView ? 'high' : 'low'}
        revealed={revealed}
        onTags={onTags}
      />
    </div>
  )
})

export const ComicStrip = forwardRef<ComicStripHandle, ComicStripProps>(
  function ComicStrip(
    {
      comicId,
      images,
      initialIndex = 0,
      orientation = 'horizontal',
      className,
      onCurrentIndexChange,
      onHover,
      onDoubleClick,
      onTags,
    },
    ref,
  ) {
    // Mark mode: every page in view shows its tag controls, for a finger,
    // which cannot hover. Moving to another page leaves it.
    const [marking, setMarking] = useState(false)
    const {
      containerRef,
      currentIndex,
      jumpTo,
      step,
      layout,
      onScroll,
      visibleRange,
    } = useComicStrip({
      images,
      initialIndex,
      orientation,
      onCurrentIndexChange: (index) => {
        setMarking(false)
        onCurrentIndexChange?.(index)
      },
    })

    useImperativeHandle(ref, () => ({ currentIndex, jumpTo, step }), [
      currentIndex,
      jumpTo,
      step,
    ])

    // A finger taps the first / last third of the strip (along its reading
    // axis) to step a page at once, and the middle for mark mode; a double
    // tap there opens the page in the preview. A mouse shows a page's tags on
    // hover, steps with the arrow keys and double-clicks to preview.
    const zoneOf = (press: Press) => {
      const container = containerRef.current
      return container
        ? pressZone(container.getBoundingClientRect(), press, orientation)
        : 0
    }
    const gestures = usePressGestures({
      canDoubleTap: (press) =>
        press.pointerType !== 'touch' || zoneOf(press) === 0,
      onTap: (press) => {
        if (press.pointerType !== 'touch') return
        const zone = zoneOf(press)
        if (zone === 0) setMarking((v) => !v)
        else step(zone)
      },
      onDoubleTap: (press) => {
        const page =
          press.target instanceof Element
            ? press.target.closest<HTMLElement>('[data-page-index]')
            : null
        if (page) onDoubleClick?.(Number(page.dataset.pageIndex))
      },
    })

    return (
      <div
        ref={containerRef}
        className={cn(
          'scrollbar-hide min-h-0 min-w-0 touch-manipulation',
          orientation === 'horizontal'
            ? 'overflow-x-auto overflow-y-hidden'
            : 'overflow-x-hidden overflow-y-auto',
          className,
        )}
        onScroll={onScroll}
        {...gestures}
      >
        <div
          className="relative"
          style={
            layout
              ? orientation === 'horizontal'
                ? { width: layout.totalSize, height: '100%' }
                : { width: '100%', height: layout.totalSize }
              : undefined
          }
        >
          {layout &&
            images
              .slice(visibleRange.start, visibleRange.end + 1)
              .map((image, offset) => {
                const page = layout.pages[visibleRange.start + offset]
                if (!page) return null

                return (
                  <StripPage
                    key={image.filename}
                    comicId={comicId}
                    image={image}
                    orientation={orientation}
                    start={page.start}
                    width={page.width}
                    height={page.height}
                    inView={
                      page.index >= visibleRange.inViewStart &&
                      page.index <= visibleRange.inViewEnd
                    }
                    revealed={marking}
                    onHover={onHover}
                    onTags={onTags}
                  />
                )
              })}
        </div>
      </div>
    )
  },
)
