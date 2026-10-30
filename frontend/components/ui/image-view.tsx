import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { GridItem } from '@/components/ui/grid-item'
import { TagOverlay } from '@/components/ui/tag-overlay'
import { useImageTags } from '@/hooks/use-image-tags'
import {
  pressZone,
  usePressGestures,
  type Press,
} from '@/hooks/use-press-gestures'
import { SHORTCUTS } from '@/lib/shortcuts'
import { cn } from '@/lib/style'
import type { FileTags, Image } from '@/types/library'

// Min horizontal travel (px) for a touch drag to count as a prev/next swipe.
const SWIPE_THRESHOLD = 50
// A page image that fails to load (a dropped connection) is requested again
// after each of these delays; the thumbnail stays up meanwhile.
const RETRY_DELAYS_MS = [1000, 3000]

interface ImageProps {
  comicId: string
  image: Image
  onTags?: (id: string, imageKey: string, tags: FileTags) => Promise<void>
  onClick?: (index: number) => void
  onDoubleClick?: (index: number) => void
  isSelected?: boolean
  className?: string
  loading?: 'eager' | 'lazy'
  fetchPriority?: 'high' | 'low' | 'auto'
  // Shows the tag controls: the reader's mark mode (full-size pages).
  revealed?: boolean
}

interface GridImageProps extends ImageProps {
  // Hover / long press reveals the tag buttons and filename (page grid).
  revealTags?: boolean
}

export function GridImage({
  comicId,
  image,
  onClick,
  onDoubleClick,
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
      deleted={image.deleted}
      isSelected={isSelected}
      revealTags={revealTags}
      loading={loading}
      onClick={() => onClick?.(image.index)}
      onDoubleClick={() => onDoubleClick?.(image.index)}
      onStar={
        onTags &&
        (() => void onTags(comicId, image.path, { starred: !image.starred }))
      }
      onDelete={
        onTags &&
        (() => void onTags(comicId, image.path, { deleted: !image.deleted }))
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
        className={cn(
          'bg-overlay absolute inset-0 bg-cover bg-center bg-no-repeat',
          image.deleted && 'grayscale',
        )}
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
          image.deleted && 'grayscale',
        )}
      />
    </>
  )
}

function SingleImage({ comicId, image, onTags, revealed }: ImageProps) {
  const { hoverProps, controls } = useImageTags(
    comicId,
    image,
    onTags,
    revealed,
  )

  return (
    <figure className="flex h-full w-full items-center justify-center">
      <div
        {...hoverProps}
        className="group relative max-h-full max-w-full"
        style={{
          aspectRatio: `${image.width} / ${image.height}`,
        }}
      >
        <img
          key={image.url}
          src={image.url}
          alt={image.filename}
          decoding="async"
          className={cn(
            'block h-full w-full object-contain [-webkit-touch-callout:default]',
            image.deleted && 'grayscale',
          )}
        />
        <TagOverlay layout="bar" {...controls} />
      </div>
    </figure>
  )
}

export function ScrollImage({
  comicId,
  image,
  onTags,
  revealed,
  className = 'h-full',
  loading = 'eager',
  fetchPriority,
}: ImageProps) {
  const { hoverProps, controls } = useImageTags(
    comicId,
    image,
    onTags,
    revealed,
  )

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

interface ImagePreviewProps extends Omit<ImageProps, 'image' | 'onClick'> {
  images: Image[]
  index: number
  onIndexChange: (index: number) => void
}

function ImagePreview({
  comicId,
  images,
  index,
  onIndexChange,
  onTags,
  onDoubleClick,
}: ImagePreviewProps) {
  const currentImage = images[index]
  const containerRef = useRef<HTMLDivElement>(null)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  // The tag bar a finger opened; every page flip closes it.
  const [revealed, setRevealed] = useState(false)

  const goPrev = () => {
    if (index <= 0) return
    setRevealed(false)
    onIndexChange(index - 1)
  }
  const goNext = () => {
    if (index >= images.length - 1) return
    setRevealed(false)
    onIndexChange(index + 1)
  }

  // A finger taps the left / right third to flip pages at once and the middle
  // to show the tag bar; a double tap there closes the preview. A mouse
  // flips with the arrow keys, shows the bar on hover and double-clicks to
  // close.
  const zoneOf = (press: Press) => {
    const container = containerRef.current
    return container
      ? pressZone(container.getBoundingClientRect(), press, 'horizontal')
      : 0
  }
  const gestures = usePressGestures({
    canDoubleTap: (press) =>
      press.pointerType !== 'touch' || zoneOf(press) === 0,
    onTap: (press) => {
      if (press.pointerType !== 'touch') return
      const zone = zoneOf(press)
      if (zone < 0) goPrev()
      else if (zone > 0) goNext()
      else setRevealed((v) => !v)
    },
    onDoubleTap: () => onDoubleClick?.(index),
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
        onDoubleClick?.(index)
        break
    }
  })

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  // Warm the HTTP cache for the pages around this one so left/right
  // navigation paints instantly instead of fetching on keypress; reading
  // goes forward, so two ahead and one back.
  useEffect(() => {
    if (index < 0) return
    for (const neighbor of [
      images[index + 1],
      images[index + 2],
      images[index - 1],
    ]) {
      if (!neighbor) continue
      const img = new window.Image()
      img.src = neighbor.url
    }
  }, [index, images])

  // Mobile has no arrow keys: a horizontal swipe flips pages. Ignore mostly
  // vertical drags so they don't fight the double-tap-to-close gesture.
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
      ref={containerRef}
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
        revealed={revealed}
      />
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
  // Double-tap / double-click anywhere closes the overlay.
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
        onDoubleClick={onClose}
      />
    </div>
  )
}
