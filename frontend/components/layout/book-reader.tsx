import { SquareMenu, Star, StepForward, Trash2 } from 'lucide-react'
import {
  memo,
  type Ref,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Button } from '@/components/ui/button'
import { RemoteProgressPrompt } from '@/components/ui/remote-progress-prompt'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { useBookReadingSession } from '@/hooks/use-book-reading-session'
import { useClickOutside } from '@/hooks/use-click-outside'
import { useParagraphSelection } from '@/hooks/use-paragraph-selection'
import { cn } from '@/lib/style'
import { useProgressStore } from '@/store/progress'
import type { Chapter, JumpRequest } from '@/types/library'

// Rail offset from the right edge when scrollbars overlay the content (macOS,
// iOS) and take no layout width. With the rail's w-3 it ends 20px in, clear of
// the lines' pr-6 text edge.
const OVERLAY_SCROLLBAR_RAIL_OFFSET_PX = 8
const MARKER_LABEL_LENGTH = 40
// A marker's button height (h-4): markers closer than this on the rail would
// cover each other, so they merge into one.
const MARKER_SIZE_PX = 16

const BOOK_IMAGE_LINE_PATTERN = /^\s*\[\]\(([^/\\]+)\)\s*$/
// Caps lines at about 60 CJK characters (plus pl-4 pr-6) so wide windows keep
// a readable measure; narrower readers just use their full width.
const LINE_MEASURE_CLASS = 'mx-auto w-full max-w-[calc(60em+2.5rem)]'

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

// memo even with the compiler: a favorite toggled rebuilds the whole list,
// and only the lines whose props changed should render again.
const BookLine = memo(function BookLine({
  imageBaseUrl,
  line,
  index,
  starred,
}: BookLineProps) {
  const imageFilename = parseBookImageFilename(line)
  const imageUrl =
    imageBaseUrl && imageFilename
      ? new URL(encodeURIComponent(imageFilename), imageBaseUrl).toString()
      : null
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null)
  const [loadedImageUrl, setLoadedImageUrl] = useState<string | null>(null)

  if (imageUrl && failedImageUrl !== imageUrl) {
    return (
      <figure
        className={cn(
          LINE_MEASURE_CLASS,
          'pr-6 pb-4 pl-4',
          // Hold room for the picture until it loads, so the text after it
          // moves less when it comes in.
          loadedImageUrl !== imageUrl && 'min-h-[50vh]',
        )}
      >
        <img
          src={imageUrl}
          alt={imageFilename ?? '小说插图'}
          className="mx-auto max-h-[75vh] max-w-full rounded-sm object-contain"
          loading="lazy"
          decoding="async"
          onLoad={() => setLoadedImageUrl(imageUrl)}
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
})

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

interface FavoriteMarker {
  key: string
  kind: 'chapter' | 'paragraph'
  lineIndex: number
  // Position along the scroll height, 0-100.
  top: number
  label: string
}

interface MarkerGroup {
  key: string
  kind: FavoriteMarker['kind']
  // Where the first marker sits and where a click jumps.
  lineIndex: number
  top: number
  // Line of the last marker: the group counts as read once it is passed.
  lastLineIndex: number
  count: number
  label: string
}

// Merges markers whose buttons would overlap on a rail `railHeight` tall.
function groupMarkers(markers: FavoriteMarker[], railHeight: number) {
  const sorted = [...markers].sort((a, b) => a.top - b.top)
  const minGap = railHeight > 0 ? (MARKER_SIZE_PX / railHeight) * 100 : 0
  const groups: MarkerGroup[] = []
  for (const marker of sorted) {
    const group = groups.at(-1)
    if (group && marker.top - group.top < minGap) {
      group.count += 1
      group.lastLineIndex = Math.max(group.lastLineIndex, marker.lineIndex)
      group.label += `\n${marker.label}`
      // A chapter in the group shows as its dash.
      if (marker.kind === 'chapter') group.kind = 'chapter'
      continue
    }
    groups.push({
      key: marker.key,
      kind: marker.kind,
      lineIndex: marker.lineIndex,
      top: marker.top,
      lastLineIndex: marker.lineIndex,
      count: 1,
      label: marker.label,
    })
  }
  for (const group of groups) {
    if (group.count > 1) group.label = `${group.count} 处收藏\n${group.label}`
  }
  return groups
}

interface FavoriteRailProps {
  bookId: string
  markers: FavoriteMarker[]
  // Position along the scroll height (0-100) of a line, on the markers' scale.
  topOf: (lineIndex: number) => number
  right: number
  onJump: (lineIndex: number) => void
}

// Marks favorited chapters (dashes) and paragraph runs (dots) beside the
// scrollbar at their share of the scroll height; a click jumps there. A thin
// line marks the reading position, and the favorites already passed are
// dimmed, so the rail tells what is still ahead even with the scrollbar
// hidden.
function FavoriteRail({
  bookId,
  markers,
  topOf,
  right,
  onJump,
}: FavoriteRailProps) {
  const railRef = useRef<HTMLDivElement>(null)
  const [railHeight, setRailHeight] = useState(0)
  // The rail alone follows the position, so scrolling re-renders only it.
  const currentLine = useProgressStore((s) => s.books[bookId]?.current ?? 0)
  const hasMarkers = markers.length > 0
  // An explicit memo: the compiler leaves this call uncached, and the rail
  // re-renders on every progress update while scrolling.
  const groups = useMemo(
    () => groupMarkers(markers, railHeight),
    [markers, railHeight],
  )

  useLayoutEffect(() => {
    const rail = railRef.current
    if (!rail) return
    const observer = new ResizeObserver(() => {
      // A hidden reader measures 0; keep the groups it had.
      if (rail.clientHeight > 0) setRailHeight(rail.clientHeight)
    })
    observer.observe(rail)
    return () => {
      observer.disconnect()
    }
  }, [hasMarkers])

  if (!hasMarkers) return null
  return (
    <div
      ref={railRef}
      aria-label="收藏位置"
      className="pointer-events-none absolute inset-y-2 z-10 w-3"
      style={{ right }}
    >
      <span
        aria-hidden="true"
        className="bg-subtle absolute left-0 h-px w-3"
        style={{ top: `${topOf(currentLine)}%` }}
      />
      {groups.map((group) => (
        <button
          key={group.key}
          type="button"
          title={group.label}
          aria-label={group.label}
          className={cn(
            'pointer-events-auto absolute left-1/2 flex h-4 w-3 -translate-x-1/2 -translate-y-1/2 items-center justify-center',
            group.lastLineIndex < currentLine && 'opacity-40',
          )}
          style={{ top: `${group.top}%` }}
          onClick={() => {
            onJump(group.lineIndex)
          }}
        >
          <span
            className={cn(
              'rounded-full',
              group.kind === 'chapter'
                ? 'bg-gold h-0.5 w-2.5'
                : group.count > 1
                  ? 'bg-love h-2 w-2'
                  : 'bg-love h-1.5 w-1.5',
              group.kind === 'chapter' && group.count > 1 && 'h-1',
            )}
          />
        </button>
      ))}
    </div>
  )
}

// First line whose bottom is below the top edge of the scroller. `text` holds
// one element per line, in order, laid out top to bottom.
function topVisibleLine(scroller: HTMLElement, text: HTMLElement) {
  const items = text.children
  const top = scroller.scrollTop
  let low = 0
  let high = items.length - 1
  let result: number | null = null
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const item = items[mid] as HTMLElement
    if (item.offsetTop + item.offsetHeight > top) {
      result = mid
      high = mid - 1
    } else {
      low = mid + 1
    }
  }
  return result
}

function excerpt(line: string) {
  const text = line.trim()
  return text.length > MARKER_LABEL_LENGTH
    ? `${text.slice(0, MARKER_LABEL_LENGTH)}…`
    : text
}

export interface BookTextHandle {
  // Puts the line at the top of the reader.
  scrollToLine: (lineIndex: number) => void
}

interface BookTextProps {
  ref: Ref<BookTextHandle>
  bookId: string
  imageBaseUrl: string | null
  lines: readonly string[]
  onTopLineChange: (lineIndex: number) => void
  starredLines: ReadonlySet<number>
  onToggleLines: (lineIndices: number[]) => void
  favoriteChapters: Chapter[]
  onJump: (lineIndex: number) => void
}

/**
 * The whole book as one native scrolling list: books here are short enough
 * (a few thousand paragraphs) to lay out at once, which keeps every position
 * exact instead of resting on estimated line heights.
 */
function BookText({
  ref,
  bookId,
  imageBaseUrl,
  lines,
  onTopLineChange,
  starredLines,
  onToggleLines,
  favoriteChapters,
  onJump,
}: BookTextProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const { selection, clear: clearSelection } = useParagraphSelection(
    contentRef,
    (lineIndex) =>
      lineIndex < lines.length && !parseBookImageFilename(lines[lineIndex]),
  )
  const [railRight, setRailRight] = useState(OVERLAY_SCROLLBAR_RAIL_OFFSET_PX)
  // Each line's top as a share (0-100) of the scroll height, for the rail.
  const [lineTops, setLineTops] = useState<number[] | null>(null)
  // The line the last jump put at the top and where that left the scroller.
  // Until the reader scrolls, the jump holds: a reflow (a picture loading)
  // puts the line back at the top, and the scrolls the jump and the reflow
  // fire are not the reader's. They would report the line jumped to, or for
  // a line near the end (which cannot reach the top) an earlier one.
  const jumpRef = useRef<{ line: number; top: number } | null>(null)

  const scrollToLine = (lineIndex: number) => {
    const scroller = scrollerRef.current
    const line = textRef.current?.children[lineIndex] as
      | HTMLElement
      | undefined
    if (!scroller || !line) return
    scroller.scrollTop = line.offsetTop
    jumpRef.current = { line: lineIndex, top: scroller.scrollTop }
  }
  useImperativeHandle(ref, () => ({ scrollToLine }))

  const reportTopLine = useEffectEvent(() => {
    const scroller = scrollerRef.current
    const text = textRef.current
    if (!scroller || !text) return
    if (scroller.scrollTop === jumpRef.current?.top) return
    jumpRef.current = null
    const lineIndex = topVisibleLine(scroller, text)
    if (lineIndex !== null) onTopLineChange(lineIndex)
  })

  useLayoutEffect(() => {
    // Sit just left of a classic scrollbar; overlay scrollbars take no width.
    const scroller = scrollerRef.current
    if (!scroller) return
    const scrollbarWidth = scroller.offsetWidth - scroller.clientWidth
    setRailRight(
      scrollbarWidth > 0 ? scrollbarWidth + 1 : OVERLAY_SCROLLBAR_RAIL_OFFSET_PX,
    )
  }, [])

  useEffect(() => {
    const scroller = scrollerRef.current
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
  }, [])

  // Measured from the laid-out text, again whenever it reflows (a new width,
  // a picture loading), after putting a jump still held back in place.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    const text = textRef.current
    if (!scroller || !text) return
    const measure = () => {
      const total = scroller.scrollHeight
      // A hidden reader measures 0; keep what it had.
      if (!total || !scroller.clientHeight) return
      if (jumpRef.current) scrollToLine(jumpRef.current.line)
      setLineTops(
        Array.from(
          text.children,
          (line) => ((line as HTMLElement).offsetTop / total) * 100,
        ),
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(text)
    return () => {
      observer.disconnect()
    }
  }, [lines])

  const topOf = (lineIndex: number) => lineTops?.[lineIndex] ?? 0

  const markers: FavoriteMarker[] = []
  if (lineTops) {
    for (const chapter of favoriteChapters) {
      markers.push({
        key: `chapter-${chapter.lineIndex}`,
        kind: 'chapter',
        lineIndex: chapter.lineIndex,
        top: topOf(chapter.lineIndex),
        label: `章节：${chapter.title}`,
      })
    }

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
      markers.push({
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
  }

  return (
    <div ref={contentRef} className="book-reader-content relative min-h-0 flex-1">
      <div ref={scrollerRef} className="relative h-full overflow-y-auto">
        <div ref={textRef} className="py-16">
          {/* Every line of the book, rendered at once. The compiler keeps
              this list across selection changes; BookLine's memo re-renders
              only the lines a favorite toggles. */}
          {lines.map((line, index) => (
            <BookLine
              key={index}
              imageBaseUrl={imageBaseUrl}
              line={line}
              index={index}
              starred={starredLines.has(index)}
            />
          ))}
        </div>
      </div>
      <FavoriteRail
        bookId={bookId}
        markers={markers}
        topOf={topOf}
        right={railRight}
        onJump={onJump}
      />
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
    currentChapterTitle,
    isLoading,
    loadProgress,
    isTocCollapsed,
    bookTextRef,
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

      <BookText
        key={bookId}
        bookId={bookId}
        imageBaseUrl={imageBaseUrl}
        ref={bookTextRef}
        lines={lines}
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
