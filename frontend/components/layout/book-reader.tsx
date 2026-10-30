import { SquareMenu, Star, StepForward, Trash2 } from 'lucide-react'
import {
  type RefObject,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { Button } from '@/components/ui/button'
import { RemoteProgressPrompt } from '@/components/ui/remote-progress-prompt'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { useBookReadingSession } from '@/hooks/use-book-reading-session'
import { useClickOutside } from '@/hooks/use-click-outside'
import { useParagraphSelection } from '@/hooks/use-paragraph-selection'
import { cn } from '@/lib/style'
import type { Chapter, JumpRequest } from '@/types/library'

// Must match ReaderPadding's h-16; the favorites rail maps lines to pixels.
const READER_PADDING_PX = 64
const ReaderPadding = {
  Header: () => <div className="h-16" />,
  Footer: () => <div className="h-16" />,
}
// Rail offset from the right edge when scrollbars overlay the content (macOS,
// iOS) and take no layout width. With the rail's w-3 it ends 20px in, clear of
// the lines' pr-6 text edge.
const OVERLAY_SCROLLBAR_RAIL_OFFSET_PX = 8
const MARKER_LABEL_LENGTH = 40

const TOP_OVERSCAN_PX = 800
const BOTTOM_OVERSCAN_PX = 200
const RESIZE_ESTIMATE_DELAY_MS = 120
const BOOK_IMAGE_LINE_PATTERN = /^\s*\[\]\(([^/\\]+)\)\s*$/
// Caps lines at about 40 CJK characters (plus pl-4 pr-6) so wide windows keep
// a readable measure; narrower readers just use their full width.
const LINE_MEASURE_CLASS = 'mx-auto w-full max-w-[calc(40em+2.5rem)]'

function parseBookImageFilename(line: string): string | null {
  const filename = BOOK_IMAGE_LINE_PATTERN.exec(line)?.[1].trim()
  if (!filename || filename.includes('..')) return null
  return filename
}

function getBookImageBaseUrl(bookUrl: string): string | null {
  try {
    return new URL('images/', bookUrl).toString()
  } catch {
    return null
  }
}

interface BookLineProps {
  imageBaseUrl: string | null
  line: string
  index?: number
  starred?: boolean
}

function BookLine({ imageBaseUrl, line, index, starred }: BookLineProps) {
  const imageFilename = parseBookImageFilename(line)
  const imageUrl =
    imageBaseUrl && imageFilename
      ? new URL(encodeURIComponent(imageFilename), imageBaseUrl).toString()
      : null
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null)

  if (imageUrl && failedImageUrl !== imageUrl) {
    return (
      <figure className={cn(LINE_MEASURE_CLASS, 'pr-6 pb-4 pl-4')}>
        <img
          src={imageUrl}
          alt={imageFilename ?? '小说插图'}
          className="mx-auto max-h-[75vh] max-w-full rounded-sm object-contain"
          loading="lazy"
          decoding="async"
          onError={() => setFailedImageUrl(imageUrl)}
        />
      </figure>
    )
  }

  return (
    <p
      data-line-index={index}
      className={cn(
        // pr-6 keeps text clear of the favorites rail beside the scrollbar.
        LINE_MEASURE_CLASS,
        'text-text pr-6 pb-4 pl-4 font-serif leading-relaxed wrap-break-word whitespace-pre-wrap',
        starred &&
          'decoration-love/70 underline decoration-1 underline-offset-[0.3em]',
      )}
    >
      {line}
    </p>
  )
}

interface ParagraphFavoriteButtonProps {
  x: number
  y: number
  docked: boolean
  count: number
  allStarred: boolean
  onToggle: () => void
}

// Floats over the current selection (or, on touch screens, sits docked at the
// bottom of the reader); acting on it favorites (or, when every selected
// paragraph already is, unfavorites) the whole paragraphs touched.
function ParagraphFavoriteButton({
  x,
  y,
  docked,
  count,
  allStarred,
  onToggle,
}: ParagraphFavoriteButtonProps) {
  const label = allStarred ? '取消收藏' : '收藏'
  return (
    <button
      type="button"
      className={cn(
        'bg-base text-text absolute z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-sm border whitespace-nowrap shadow-md',
        docked
          ? 'bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 px-4 py-2 text-sm'
          : '-mt-2 -translate-y-full px-3 py-1.5 text-xs',
      )}
      style={docked ? undefined : { left: x, top: y }}
      // Keep the selection alive on desktop; the click acts on the paragraphs
      // captured from it anyway, in case a touch browser clears it first.
      onPointerDown={(e) => {
        e.preventDefault()
      }}
      onClick={onToggle}
    >
      <Star
        className={cn('h-3.5 w-3.5', allStarred && 'text-love fill-gold/80')}
      />
      {count > 1 ? `${label} ${count} 段` : label}
    </button>
  )
}

function pixelValue(value: string) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function estimateLineHeights(
  lines: readonly string[],
  paragraph: HTMLParagraphElement,
) {
  const style = getComputedStyle(paragraph)
  const horizontalPadding =
    pixelValue(style.paddingLeft) + pixelValue(style.paddingRight)
  const verticalPadding =
    pixelValue(style.paddingTop) + pixelValue(style.paddingBottom)
  const contentWidth = Math.max(1, paragraph.clientWidth - horizontalPadding)
  const fontSize = pixelValue(style.fontSize)
  const lineHeight = pixelValue(style.lineHeight) || fontSize
  const wrapWidth = Math.max(1, contentWidth - fontSize)
  const letterSpacing = pixelValue(style.letterSpacing)
  const context = document.createElement('canvas').getContext('2d')

  if (context) {
    // Not style.font: it is empty when a longhand has no shorthand form (the
    // page's tabular-nums), and canvas silently keeps 10px sans-serif for a
    // font string it cannot parse, such as one carrying that font-variant.
    // Every estimate then came out a line or so short.
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  }

  const fullWidthCharacter = context?.measureText('汉').width || fontSize
  const asciiCharacterWidths = Array.from({ length: 128 }, (_, code) =>
    context ? context.measureText(String.fromCharCode(code)).width : fontSize,
  )

  return lines.map((line) => {
    if (parseBookImageFilename(line)) {
      const estimatedImageHeight = Math.min(
        contentWidth * 0.75,
        window.innerHeight * 0.75,
      )
      return Math.ceil(estimatedImageHeight + lineHeight)
    }

    let measuredWidth = line.length * fullWidthCharacter
    for (let index = 0; index < line.length; index += 1) {
      const code = line.charCodeAt(index)
      if (code < asciiCharacterWidths.length) {
        measuredWidth += asciiCharacterWidths[code] - fullWidthCharacter
      }
    }
    measuredWidth += Math.max(0, line.length - 1) * letterSpacing
    const visualLineCount = Math.max(1, Math.ceil(measuredWidth / wrapWidth))

    return Math.ceil(verticalPadding + visualLineCount * lineHeight)
  })
}

interface FavoriteMarker {
  key: string
  kind: 'chapter' | 'paragraph'
  lineIndex: number
  // Position along the scroll height, 0-100.
  top: number
  label: string
}

interface FavoriteRailProps {
  markers: FavoriteMarker[]
  right: number
  onJump: (lineIndex: number) => void
}

// Marks favorited chapters (dashes) and paragraph runs (dots) beside the
// scrollbar at their share of the scroll height; a click jumps there.
function FavoriteRail({ markers, right, onJump }: FavoriteRailProps) {
  if (!markers.length) return null
  return (
    <div
      aria-label="收藏位置"
      className="pointer-events-none absolute inset-y-2 z-10 w-3"
      style={{ right }}
    >
      {markers.map((marker) => (
        <button
          key={marker.key}
          type="button"
          title={marker.label}
          aria-label={marker.label}
          className="pointer-events-auto absolute left-1/2 flex h-4 w-3 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
          style={{ top: `${marker.top}%` }}
          onClick={() => {
            onJump(marker.lineIndex)
          }}
        >
          <span
            className={cn(
              'rounded-full',
              marker.kind === 'chapter'
                ? 'bg-gold h-0.5 w-2.5'
                : 'bg-love h-1.5 w-1.5',
            )}
          />
        </button>
      ))}
    </div>
  )
}

// First line whose bottom is below the top edge of the scroller. Virtuoso's
// rangeChanged reports the rendered range, which starts TOP_OVERSCAN_PX above
// the viewport, so progress taken from it lagged behind the reading position.
function topVisibleLine(scroller: HTMLElement) {
  const top = scroller.getBoundingClientRect().top
  for (const item of scroller.querySelectorAll<HTMLElement>('[data-index]')) {
    if (item.getBoundingClientRect().bottom > top) {
      return Number(item.dataset.index)
    }
  }
  return null
}

function excerpt(line: string) {
  const text = line.trim()
  return text.length > MARKER_LABEL_LENGTH
    ? `${text.slice(0, MARKER_LABEL_LENGTH)}…`
    : text
}

interface VirtualBookProps {
  imageBaseUrl: string | null
  readInitialIndex: () => number
  lines: readonly string[]
  onTopLineChange: (lineIndex: number) => void
  virtuosoRef: RefObject<VirtuosoHandle | null>
  starredLines: ReadonlySet<number>
  onToggleLines: (lineIndices: number[]) => void
  favoriteChapters: Chapter[]
  onJump: (lineIndex: number) => void
}

function VirtualBook({
  imageBaseUrl,
  readInitialIndex,
  lines,
  onTopLineChange,
  virtuosoRef,
  starredLines,
  onToggleLines,
  favoriteChapters,
  onJump,
}: VirtualBookProps) {
  const probeRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const { selection, clear: clearSelection } = useParagraphSelection(
    contentRef,
    (lineIndex) =>
      lineIndex < lines.length && !parseBookImageFilename(lines[lineIndex]),
  )
  const [estimation, setEstimation] = useState<{
    heights: number[]
    lines: readonly string[]
    width: number
  } | null>(null)
  const hasCurrentEstimates = estimation?.lines === lines
  const [railRight, setRailRight] = useState(OVERLAY_SCROLLBAR_RAIL_OFFSET_PX)
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const reportTopLine = useEffectEvent(() => {
    if (!scroller) return
    const lineIndex = topVisibleLine(scroller)
    if (lineIndex !== null) onTopLineChange(lineIndex)
  })

  useEffect(() => {
    if (!scroller) return
    let frame: number | null = null
    const handleScroll = () => {
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        reportTopLine()
      })
    }
    scroller.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', handleScroll)
    }
  }, [scroller])

  // Sit just left of a classic scrollbar; overlay scrollbars take no width.
  useLayoutEffect(() => {
    const scroller = contentRef.current?.querySelector<HTMLElement>(
      '[data-virtuoso-scroller]',
    )
    if (!scroller) return
    const scrollbarWidth = scroller.offsetWidth - scroller.clientWidth
    setRailRight(
      scrollbarWidth > 0 ? scrollbarWidth + 1 : OVERLAY_SCROLLBAR_RAIL_OFFSET_PX,
    )
  }, [estimation])

  // Positions use the same per-line height estimates Virtuoso scrolls by, so
  // markers line up with the scrollbar thumb rather than with line counts.
  const layout = useMemo(() => {
    if (!estimation) return null
    const offsets: number[] = []
    let total = READER_PADDING_PX
    for (const height of estimation.heights) {
      offsets.push(total)
      total += height
    }
    return { lines: estimation.lines, offsets, total: total + READER_PADDING_PX }
  }, [estimation])

  const markers = useMemo(() => {
    if (!layout || layout.lines !== lines) return []
    const topOf = (lineIndex: number) =>
      ((layout.offsets[lineIndex] ?? 0) / layout.total) * 100

    const result: FavoriteMarker[] = favoriteChapters.map((chapter) => ({
      key: `chapter-${chapter.lineIndex}`,
      kind: 'chapter',
      lineIndex: chapter.lineIndex,
      top: topOf(chapter.lineIndex),
      label: `章节：${chapter.title}`,
    }))

    // One dot per run of consecutive favorited paragraphs.
    const sorted = [...starredLines].sort((a, b) => a - b)
    for (let i = 0; i < sorted.length; ) {
      const start = sorted[i]
      let end = start
      while (sorted[i + 1] === end + 1) {
        end += 1
        i += 1
      }
      i += 1
      const count = end - start + 1
      result.push({
        key: `paragraph-${start}`,
        kind: 'paragraph',
        lineIndex: start,
        top: topOf(start),
        label:
          count > 1
            ? `${excerpt(lines[start])}（共 ${count} 段）`
            : excerpt(lines[start]),
      })
    }
    return result
  }, [favoriteChapters, layout, lines, starredLines])

  useLayoutEffect(() => {
    const probe = probeRef.current
    const paragraph = probe?.querySelector('p')
    if (!probe || !paragraph) return

    let lastEstimatedWidth = 0
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const estimate = () => {
      const width = paragraph.clientWidth
      if (width <= 0 || width === lastEstimatedWidth) return
      lastEstimatedWidth = width
      const heights = estimateLineHeights(lines, paragraph)
      setEstimation({ heights, lines, width })
    }
    const scheduleEstimate = () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(estimate, RESIZE_ESTIMATE_DELAY_MS)
    }

    const observer = new ResizeObserver(scheduleEstimate)
    observer.observe(probe)
    estimate()

    return () => {
      clearTimeout(resizeTimer)
      observer.disconnect()
    }
  }, [lines])

  return (
    <div ref={contentRef} className="book-reader-content relative min-h-0 flex-1">
      {hasCurrentEstimates ? (
        <Virtuoso
          key={estimation.width}
          ref={virtuosoRef}
          className="h-full"
          data={lines}
          heightEstimates={estimation.heights}
          initialTopMostItemIndex={readInitialIndex()}
          scrollerRef={(element) => {
            setScroller(element instanceof HTMLElement ? element : null)
          }}
          itemContent={(index, line) => (
            <BookLine
              imageBaseUrl={imageBaseUrl}
              line={line}
              index={index}
              starred={starredLines.has(index)}
            />
          )}
          components={ReaderPadding}
          increaseViewportBy={{
            top: TOP_OVERSCAN_PX,
            bottom: BOTTOM_OVERSCAN_PX,
          }}
        />
      ) : null}
      <FavoriteRail markers={markers} right={railRight} onJump={onJump} />
      {selection && (
        <ParagraphFavoriteButton
          x={selection.x}
          y={selection.y}
          docked={selection.docked}
          count={selection.lines.length}
          allStarred={selection.lines.every((line) => starredLines.has(line))}
          onToggle={() => {
            onToggleLines(selection.lines)
            clearSelection()
          }}
        />
      )}
      <div
        aria-hidden="true"
        className="invisible absolute inset-0 overflow-y-scroll"
      >
        <div ref={probeRef}>
          <BookLine imageBaseUrl={imageBaseUrl} line="测量" />
        </div>
      </div>
    </div>
  )
}

interface TableOfContentsProps {
  chapters: Chapter[]
  currentChapterTitle: string
  isCollapsed: boolean
  onSelect: (lineIndex: number) => void
  onToggleFavorite: (chapter: Chapter) => void
  onClose: () => void
}

function TableOfContents({
  chapters,
  currentChapterTitle,
  isCollapsed,
  onSelect,
  onToggleFavorite,
  onClose,
}: TableOfContentsProps) {
  const tocRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useClickOutside(tocRef, onClose, !isCollapsed)

  // Open at the chapter being read; later progress changes leave the list
  // where the reader has scrolled it.
  useEffect(() => {
    if (isCollapsed) return
    scrollRef.current
      ?.querySelector('[data-active]')
      ?.scrollIntoView({ block: 'center' })
  }, [isCollapsed])

  return (
    <div
      ref={tocRef}
      className={cn(
        'bg-base absolute top-8 left-0 z-100 h-full w-64 transition-transform duration-300 ease-in-out',
        isCollapsed ? '-translate-x-full' : 'translate-x-0',
      )}
    >
      <ScrollArea ref={scrollRef} viewportClassName="h-full" className="pb-12">
        {chapters.map((chapter) => {
          const isFavorite = chapter.starred
          const isActiveLine = currentChapterTitle === chapter.title
          return (
            <div
              key={chapter.lineIndex}
              data-active={isActiveLine || undefined}
              className="group hover:bg-overlay flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-left text-sm"
              onClick={() => {
                onSelect(chapter.lineIndex)
              }}
            >
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  isActiveLine && 'text-love',
                )}
              >
                {chapter.title}
              </span>
              <button
                type="button"
                className={cn(
                  'shrink-0 transition-opacity',
                  isFavorite
                    ? 'opacity-100'
                    : 'opacity-0 group-hover:opacity-100',
                )}
                title="收藏章节"
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleFavorite(chapter)
                }}
              >
                <Star
                  className={cn(
                    'h-4 w-4',
                    isFavorite && 'text-love fill-gold/80',
                  )}
                />
              </button>
            </div>
          )
        })}
      </ScrollArea>
    </div>
  )
}

interface BookReaderProps {
  bookId: string
  surface: 'library' | 'tab'
  showReading?: boolean
  jumpRequest?: JumpRequest
}

export function BookReader({
  bookId,
  surface,
  showReading = false,
  jumpRequest,
}: BookReaderProps) {
  const {
    book,
    content,
    lines,
    percent,
    readPosition,
    currentChapterTitle,
    isLoading,
    loadProgress,
    isTocCollapsed,
    virtuosoRef,
    closeToc,
    toggleToc,
    jumpTo,
    trackTopLine,
    continueReading,
    toggleBookDeleted,
    toggleBookStarred,
    toggleChapterStarred,
    remoteProgress,
    jumpToRemote,
    keepLocalPosition,
    starredLines,
    toggleLines,
  } = useBookReadingSession({ bookId, surface, jumpRequest })

  if (!book) return null

  if (!content) {
    return (
      <div className="bg-surface text-subtle flex h-full w-full flex-col items-center justify-center gap-3">
        {isLoading && (
          <>
            <Spinner size="large" />
            {loadProgress > 0 && (
              <span className="text-xs tabular-nums">{loadProgress}%</span>
            )}
          </>
        )}
      </div>
    )
  }

  const imageBaseUrl = getBookImageBaseUrl(book.path)
  // The store's chapters carry live star toggles; content.chapters is the
  // snapshot taken when the book loaded.
  const chapters = book.chapters.length ? book.chapters : content.chapters
  const favoriteChapters = chapters.filter((chapter) => chapter.starred)

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      {content.chapters && (
        <TableOfContents
          chapters={chapters}
          currentChapterTitle={currentChapterTitle}
          isCollapsed={isTocCollapsed}
          onSelect={jumpTo}
          onToggleFavorite={toggleChapterStarred}
          onClose={closeToc}
        />
      )}

      <div className="bg-base text-subtle relative grid h-8 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 overflow-hidden border-b px-3 text-xs">
        <div className="flex shrink-0 gap-2">
          <Button
            className="hover:bg-overlay h-6 w-6 bg-transparent"
            onClick={toggleToc}
            onMouseDown={(e) => {
              e.stopPropagation()
            }}
            title="展开目录"
            disabled={!content.chapters.length}
          >
            <SquareMenu className="h-4 w-4" />
          </Button>

          {showReading && (
            <Button
              className="h-6 w-6"
              onClick={continueReading}
              title="继续阅读"
            >
              <StepForward className="h-4 w-4" />
            </Button>
          )}

          <Button
            className="h-6 w-6"
            onClick={toggleBookDeleted}
            title="标记删除"
          >
            <Trash2
              className={cn('h-4 w-4', book.deleted && 'text-subtle/40')}
            />
          </Button>

          <Button
            className="h-6 w-6"
            onClick={toggleBookStarred}
            title="标记收藏"
          >
            <Star
              className={cn(
                'h-4 w-4',
                book.starred && 'text-love fill-gold/80',
              )}
            />
          </Button>
        </div>

        <h3
          className="min-w-0 truncate text-left"
          title={currentChapterTitle || book.title}
        >
          {currentChapterTitle || book.title}
        </h3>

        <div className="flex shrink-0 gap-2 whitespace-nowrap">
          {isLoading ? (
            <span className="tabular-nums">
              {loadProgress > 0 ? `${loadProgress}%` : '刷新中'}
            </span>
          ) : percent > 0 ? (
            <span>{percent}%</span>
          ) : (
            null
          )}
        </div>
      </div>

      <VirtualBook
        key={bookId}
        imageBaseUrl={imageBaseUrl}
        virtuosoRef={virtuosoRef}
        lines={lines}
        readInitialIndex={readPosition}
        onTopLineChange={trackTopLine}
        starredLines={starredLines}
        onToggleLines={toggleLines}
        favoriteChapters={favoriteChapters}
        onJump={jumpTo}
      />

      {remoteProgress && (
        <RemoteProgressPrompt
          label={[
            remoteProgress.currentChapterTitle,
            `${Math.round(remoteProgress.percent)}%`,
          ]
            .filter(Boolean)
            .join(' · ')}
          onJump={jumpToRemote}
          onDismiss={keepLocalPosition}
        />
      )}
    </div>
  )
}
