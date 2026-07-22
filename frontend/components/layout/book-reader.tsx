import { SquareMenu, Star, StepForward, Trash2 } from 'lucide-react'
import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import {
  type ListRange,
  Virtuoso,
  type VirtuosoHandle,
} from 'react-virtuoso'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { useBookReadingSession } from '@/hooks/use-book-reading-session'
import { useClickOutside } from '@/hooks/use-click-outside'
import { cn } from '@/lib/style'
import type { Chapter } from '@/types/library'

const ReaderPadding = {
  Header: () => <div className="h-16" />,
  Footer: () => <div className="h-16" />,
}

const TOP_OVERSCAN_PX = 800
const BOTTOM_OVERSCAN_PX = 200
const RESIZE_ESTIMATE_DELAY_MS = 120

function BookLine({ line }: { line: string }) {
  return (
    <p className="text-text mx-auto w-full px-4 pb-4 font-serif leading-relaxed wrap-break-word whitespace-pre-wrap">
      {line}
    </p>
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
    context.font =
      style.font ||
      `${style.fontStyle} ${style.fontVariant} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  }

  const fullWidthCharacter = context?.measureText('汉').width || fontSize
  const asciiCharacterWidths = Array.from({ length: 128 }, (_, code) =>
    context ? context.measureText(String.fromCharCode(code)).width : fontSize,
  )

  return lines.map((line) => {
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

interface VirtualBookProps {
  initialTopMostItemIndex: number
  lines: readonly string[]
  rangeChanged: (range: ListRange) => void
  virtuosoRef: RefObject<VirtuosoHandle | null>
}

function VirtualBook({
  initialTopMostItemIndex,
  lines,
  rangeChanged,
  virtuosoRef,
}: VirtualBookProps) {
  const probeRef = useRef<HTMLDivElement>(null)
  const [estimation, setEstimation] = useState<{
    heights: number[]
    lines: readonly string[]
    width: number
  } | null>(null)
  const hasCurrentEstimates = estimation?.lines === lines

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
    <div className="book-reader-content relative min-h-0 flex-1">
      {hasCurrentEstimates ? (
        <Virtuoso
          key={estimation.width}
          ref={virtuosoRef}
          className="h-full"
          data={lines}
          heightEstimates={estimation.heights}
          initialTopMostItemIndex={initialTopMostItemIndex}
          rangeChanged={rangeChanged}
          itemContent={(_index, line) => <BookLine line={line} />}
          components={ReaderPadding}
          increaseViewportBy={{
            top: TOP_OVERSCAN_PX,
            bottom: BOTTOM_OVERSCAN_PX,
          }}
        />
      ) : null}
      <div
        aria-hidden="true"
        className="invisible absolute inset-0 overflow-y-scroll"
      >
        <div ref={probeRef}>
          <BookLine line="测量" />
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

  useClickOutside(tocRef, onClose, !isCollapsed)

  return (
    <div
      ref={tocRef}
      className={cn(
        'bg-base absolute top-8 left-0 z-100 h-full w-64 transition-transform duration-300 ease-in-out',
        isCollapsed ? '-translate-x-full' : 'translate-x-0',
      )}
    >
      <ScrollArea viewportClassName="h-full" className="pb-12">
        {chapters.map((chapter) => {
          const isFavorite = chapter.starred
          const isActiveLine = currentChapterTitle === chapter.title
          return (
            <div
              key={chapter.lineIndex}
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
}

export function BookReader({
  bookId,
  surface,
  showReading = false,
}: BookReaderProps) {
  const {
    book,
    content,
    lines,
    progress,
    currentIndex,
    currentChapterTitle,
    isLoading,
    loadProgress,
    isTocCollapsed,
    virtuosoRef,
    closeToc,
    toggleToc,
    jumpTo,
    trackRange,
    continueReading,
    toggleBookDeleted,
    toggleBookStarred,
    toggleChapterStarred,
  } = useBookReadingSession({ bookId, surface })

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

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      {content.chapters && (
        <TableOfContents
          chapters={content.chapters}
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
          ) : progress?.percent > 0 ? (
            <span>{Math.round(progress.percent)}%</span>
          ) : (
            null
          )}
        </div>
      </div>

      <VirtualBook
        key={bookId}
        virtuosoRef={virtuosoRef}
        lines={lines}
        initialTopMostItemIndex={currentIndex}
        rangeChanged={trackRange}
      />
    </div>
  )
}
