import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { GridItem } from '@/components/ui/grid-item'
import { useStarBurst } from '@/components/ui/star-burst'
import { TagOverlay } from '@/components/ui/tag-overlay'
import { useImageTags } from '@/hooks/use-image-tags'
import { usePressGestures } from '@/hooks/use-press-gestures'
import { SHORTCUTS } from '@/lib/shortcuts'
import { cn } from '@/lib/style'
import type { FileTags, Image } from '@/types/library'

// Min horizontal travel (px) for a touch drag to count as a prev/next swipe.
const SWIPE_THRESHOLD = 50
// A two-finger trackpad swipe flips once its horizontal scroll adds up to
// this; the rest of that gesture, momentum included, is ignored until no
// scroll has come for WHEEL_IDLE_MS.
const WHEEL_THRESHOLD = 60
const WHEEL_IDLE_MS = 200
// A page image that fails to load (a dropped connection) is requested again
// after each of these delays; the thumbnail stays up meanwhile.
const RETRY_DELAYS_MS = [1000, 3000]

interface ImageProps {
  comicId: string
  image: Image
  onTags?: (id: string, imageKey: string, tags: FileTags) => Promise<void>
  onClick?: (index: number) => void
  isSelected?: boolean
  className?: string
  loading?: 'eager' | 'lazy'
  fetchPriority?: 'high' | 'low' | 'auto'
}

interface GridImageProps extends ImageProps {
  // Hover / long press reveals the star button and filename (page grid).
  revealTags?: boolean
}

export function GridImage({
  comicId,
  image,
  onClick,
  isSelected,
  className,
  onTags,
  revealTags,
  loading,
}: GridImageProps) {
  return (
    <GridItem
      className={className}
      title={image.filename}
      cover={image.thumbnail}
      starred={image.starred}
      isSelected={isSelected}
      revealTags={revealTags}
      loading={loading}
      onClick={() => onClick?.(image.index)}
      onStar={
        onTags &&
        (() => void onTags(comicId, image.path, { starred: !image.starred }))
      }
    />
  )
}

interface ProgressiveImageProps {
  image: Image
  loading?: 'eager' | 'lazy'
  fetchPriority?: 'high' | 'low' | 'auto'
}

function ProgressiveImage({
  image,
  loading = 'eager',
  fetchPriority,
}: ProgressiveImageProps) {
  const [loadedUrl, setLoadedUrl] = useState('')
  const isFullLoaded = loadedUrl === image.url
  const [attempt, setAttempt] = useState({ url: image.url, retries: 0 })
  const retries = attempt.url === image.url ? attempt.retries : 0
  const retryTimerRef = useRef<number | null>(null)

  // A retry belongs to one URL: a refresh that re-versions the page drops it.
  useEffect(
    () => () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
    },
    [image.url],
  )

  return (
    <>
      <div
        aria-hidden="true"
        className="bg-overlay absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: `url("${image.thumbnail}")` }}
      />
      <img
        // A new element requests the image again; the same one would not.
        key={`${image.url}#${retries}`}
        src={image.url}
        alt={image.filename}
        decoding="async"
        loading={loading}
        fetchPriority={fetchPriority}
        onLoad={() => {
          setLoadedUrl(image.url)
        }}
        onError={() => {
          if (retries >= RETRY_DELAYS_MS.length) return
          const url = image.url
          retryTimerRef.current = window.setTimeout(() => {
            retryTimerRef.current = null
            setAttempt({ url, retries: retries + 1 })
          }, RETRY_DELAYS_MS[retries])
        }}
        className={cn(
          'absolute inset-0 block h-full w-full object-contain transition-opacity duration-100 [-webkit-touch-callout:default]',
          isFullLoaded ? 'opacity-100' : 'opacity-0',
        )}
      />
    </>
  )
}

function SingleImage({ comicId, image, onTags }: ImageProps) {
  const { hoverProps, controls } = useImageTags(comicId, image, onTags)

  return (
    <figure
      className="flex h-full w-full items-center justify-center"
      style={{ containerType: 'size' }}
    >
      <div
        {...hoverProps}
        className="group relative"
        // The page's fitted box, sized before either image loads so the
        // thumbnail and the full image stack in it and the tag bar sits on
        // the page's top edge.
        style={{
          aspectRatio: `${image.width} / ${image.height}`,
          width: `min(100cqw, calc(100cqh * ${image.width / image.height}))`,
        }}
      >
        <ProgressiveImage image={image} fetchPriority="high" />
        <TagOverlay layout="bar" {...controls} />
      </div>
    </figure>
  )
}

export function ScrollImage({
  comicId,
  image,
  onTags,
  className = 'h-full',
  loading = 'eager',
  fetchPriority,
}: ImageProps) {
  const { hoverProps, controls } = useImageTags(comicId, image, onTags)

  return (
    <figure
      className={cn('group relative shrink-0', className)}
      style={{
        aspectRatio: `${image.width} / ${image.height}`,
      }}
      {...hoverProps}
    >
      <ProgressiveImage
        image={image}
        loading={loading}
        fetchPriority={fetchPriority}
      />
      <TagOverlay layout="bar" {...controls} />
    </figure>
  )
}

interface ImagePreviewProps {
  comicId: string
  images: Image[]
  index: number
  onIndexChange: (index: number) => void
  onClose: () => void
  onTags: (id: string, imageKey: string, tags: FileTags) => Promise<void>
}

function ImagePreview({
  comicId,
  images,
  index,
  onIndexChange,
  onTags,
  onClose,
}: ImagePreviewProps) {
  const currentImage = images[index]
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const starBurst = useStarBurst()

  const goPrev = () => {
    if (index <= 0) return
    onIndexChange(index - 1)
  }
  const goNext = () => {
    if (index >= images.length - 1) return
    onIndexChange(index + 1)
  }

  // A tap or click closes the preview and a double one toggles the page's
  // star, for a finger and a mouse alike. A finger or two on a trackpad swipe
  // to flip pages; a mouse flips with the arrow keys and shows the tag bar on
  // hover.
  const gestures = usePressGestures({
    onTap: onClose,
    onDoubleTap: (press) => {
      if (!currentImage) return
      const starred = !currentImage.starred
      void onTags(comicId, currentImage.path, { starred })
      starBurst.show(press.x, press.y, starred)
    },
  })

  const handleKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (index < 0) return

    switch (e.code) {
      case SHORTCUTS.prevImage:
        goPrev()
        break
      case SHORTCUTS.nextImage:
        goNext()
        break
      case SHORTCUTS.closePreview:
        onClose()
        break
    }
  })

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  const wheelRef = useRef({ dx: 0, flipped: false, timer: 0 })
  const handleWheel = useEffectEvent((e: WheelEvent) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    // Also keeps the browser's own swipe from going back / forward in history.
    e.preventDefault()
    const wheel = wheelRef.current
    clearTimeout(wheel.timer)
    wheel.timer = window.setTimeout(() => {
      wheel.dx = 0
      wheel.flipped = false
    }, WHEEL_IDLE_MS)
    if (wheel.flipped) return
    wheel.dx += e.deltaX
    if (Math.abs(wheel.dx) < WHEEL_THRESHOLD) return
    wheel.flipped = true
    // Fingers moving left scroll right (positive deltaX): the next page, as
    // with a finger swipe.
    if (wheel.dx > 0) goNext()
    else goPrev()
  })

  // Not React's onWheel: that listener is passive and cannot preventDefault.
  useEffect(() => {
    const wheel = wheelRef.current
    window.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      window.removeEventListener('wheel', handleWheel)
      clearTimeout(wheel.timer)
    }
  }, [])

  // Warm the HTTP cache for the pages around this one so left/right
  // navigation paints instantly instead of fetching on keypress; reading
  // goes forward, so two ahead and one back. Thumbnails go first: they are
  // what a flip shows until the full image is in.
  useEffect(() => {
    if (index < 0) return
    const neighbors = [images[index + 1], images[index + 2], images[index - 1]]
    for (const key of ['thumbnail', 'url'] as const) {
      for (const neighbor of neighbors) {
        if (!neighbor) continue
        const img = new window.Image()
        img.src = neighbor[key]
      }
    }
  }, [index, images])

  // Mobile has no arrow keys: a horizontal swipe flips pages. Ignore mostly
  // vertical drags.
  const handleTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0]
    touchStartRef.current = { x: t.clientX, y: t.clientY }
  }
  const handleTouchEnd = (e: React.TouchEvent) => {
    const start = touchStartRef.current
    touchStartRef.current = null
    if (!start) return

    const t = e.changedTouches[0]
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) <= Math.abs(dy)) return

    if (dx < 0) goNext()
    else goPrev()
  }

  if (!currentImage) return null

  return (
    <div
      className="relative flex h-full w-full touch-manipulation flex-col"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      {...gestures}
    >
      <SingleImage
        // Re-key per page so a hover from the last page does not carry over.
        key={currentImage.filename}
        comicId={comicId}
        image={currentImage}
        onTags={onTags}
      />
      {starBurst.node}
    </div>
  )
}

interface ImagePreviewOverlayProps {
  comicId: string
  images: Image[]
  active: boolean
  // Index of the previewed page; < 0 keeps the overlay closed.
  index: number
  onIndexChange: (index: number) => void
  // A tap or click anywhere (or Escape) closes the overlay.
  onClose: () => void
  onTags: (id: string, imageKey: string, tags: FileTags) => Promise<void>
}

export function ImagePreviewOverlay({
  comicId,
  images,
  active,
  index,
  onIndexChange,
  onClose,
  onTags,
}: ImagePreviewOverlayProps) {
  const isVisible = active && index >= 0 && Boolean(images[index])

  if (!isVisible) return null

  return (
    <div
      role="dialog"
      aria-label="图片预览"
      className="bg-base fixed inset-0 z-100 flex items-center justify-center"
    >
      <ImagePreview
        comicId={comicId}
        images={images}
        index={index}
        onIndexChange={onIndexChange}
        onTags={onTags}
        onClose={onClose}
      />
    </div>
  )
}
