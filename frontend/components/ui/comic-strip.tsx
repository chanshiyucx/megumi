import { forwardRef, memo, useImperativeHandle } from 'react'
import { ScrollImage } from '@/components/ui/image-view'
import { useStarBurst } from '@/components/ui/star-burst'
import {
  useComicStrip,
  type ComicStripOrientation,
} from '@/hooks/use-comic-strip'
import { usePressGestures, type Press } from '@/hooks/use-press-gestures'
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
  // Opens the page in the preview: a tap or click on it.
  onOpen?: (index: number) => void
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
      onOpen,
      onTags,
    },
    ref,
  ) {
    const starBurst = useStarBurst()
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
      onCurrentIndexChange,
    })

    useImperativeHandle(ref, () => ({ currentIndex, jumpTo, step }), [
      currentIndex,
      jumpTo,
      step,
    ])

    // A tap or click opens a page in the preview and a double one toggles its
    // star, for a finger and a mouse alike. A mouse also shows a page's tags
    // on hover and steps with the arrow keys.
    const pageOf = (press: Press) => {
      const page =
        press.target instanceof Element
          ? press.target.closest<HTMLElement>('[data-page-index]')
          : null
      return page ? images[Number(page.dataset.pageIndex)] : undefined
    }
    const gestures = usePressGestures({
      onTap: (press) => {
        const image = pageOf(press)
        if (image) onOpen?.(image.index)
      },
      onDoubleTap: (press) => {
        const image = pageOf(press)
        if (!image) return
        const starred = !image.starred
        void onTags(comicId, image.path, { starred })
        starBurst.show(press.x, press.y, starred)
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
                    onHover={onHover}
                    onTags={onTags}
                  />
                )
              })}
        </div>
        {starBurst.node}
      </div>
    )
  },
)
