import { Grid2x2, Rows2, Star, StepForward, Trash2 } from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { VirtuosoGrid } from 'react-virtuoso'
import { Button } from '@/components/ui/button'
import { ComicStrip, type ComicStripHandle } from '@/components/ui/comic-strip'
import { GridImage, ImagePreviewOverlay } from '@/components/ui/image-view'
import { useComicReadingSession } from '@/hooks/use-comic-reading-session'
import { cn } from '@/lib/style'
import { useUIStore } from '@/store/ui'
import type { Image, JumpRequest } from '@/types/library'

interface ComicPanelProps {
  comicId: string
  className?: string
  readerVisible: boolean
  // Moves the panel to a page once that comic's images are loaded.
  jumpRequest?: JumpRequest
}

/**
 * The page side of a comic surface: toolbar plus page grid or vertical strip,
 * with the full-size preview overlay. Shared by the comic library and the
 * favorites view; opening a tab only happens through "继续阅读".
 */
export function ComicPanel({
  comicId,
  className,
  readerVisible,
  jumpRequest,
}: ComicPanelProps) {
  const stripRef = useRef<ComicStripHandle>(null)
  const handledJumpRef = useRef(0)
  // The grid ignores scrollToIndex until it has measured itself, so a jump
  // remounts it starting at the target page instead.
  const [gridStart, setGridStart] = useState<JumpRequest | null>(null)

  const viewMode = useUIStore((s) => s.comicLibraryViewMode)
  const setViewMode = useUIStore((s) => s.setComicLibraryViewMode)

  const toggleViewMode = () => {
    setViewMode(viewMode === 'grid' ? 'scroll' : 'grid')
  }

  const {
    comic,
    images,
    comicImageStatus,
    currentIndex,
    previewIndex,
    setPreviewIndex,
    previewActive,
    jumpTo,
    trackStripIndex,
    setHoveredIndex,
    closePreview,
    continueReading,
    toggleComicDeleted,
    toggleComicStarred,
    updateComicImageTags,
  } = useComicReadingSession({
    comicId,
    stripRef,
    surface: {
      kind: 'library',
      readerVisible,
      viewMode,
      onToggleViewMode: toggleViewMode,
    },
  })

  const applyJump = useEffectEvent((request: JumpRequest) => {
    handledJumpRef.current = request.seq
    jumpTo(request.index)
    setGridStart(request)
  })

  useEffect(() => {
    if (!jumpRequest || jumpRequest.id !== comicId) return
    if (handledJumpRef.current === jumpRequest.seq || !images.length) return
    applyJump(jumpRequest)
  }, [comicId, images.length, jumpRequest])

  const gridStartForComic = gridStart?.id === comicId ? gridStart : null

  const pageStatusText = (() => {
    if (!comic) return ''
    if (images.length) return `${currentIndex + 1} / ${images.length}`
    if (comicImageStatus === 'failed') return '加载失败'
    if (comicImageStatus === 'empty') return '暂无图片'
    return '加载中'
  })()

  const renderGridImage = (_index: number, img: Image) => (
    <GridImage
      comicId={comicId}
      image={img}
      isSelected={currentIndex === img.index}
      tagOnTap
      onClick={jumpTo}
      onDoubleClick={setPreviewIndex}
      onTags={updateComicImageTags}
    />
  )

  return (
    <div className={cn('min-h-0 flex-1 flex-col', className)}>
      <div className="bg-base text-subtle relative grid h-8 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 overflow-hidden border-b px-3 text-xs">
        <div className="flex shrink-0 gap-2">
          <Button
            className="h-6 w-6"
            onClick={toggleViewMode}
            title={viewMode === 'grid' ? '原图预览' : '网格模式'}
          >
            {viewMode === 'grid' ? (
              <Rows2 className="h-4 w-4" />
            ) : (
              <Grid2x2 className="h-4 w-4" />
            )}
          </Button>
          <Button
            className="h-6 w-6"
            onClick={continueReading}
            title="继续阅读"
          >
            <StepForward className="h-4 w-4" />
          </Button>
          {comic && (
            <>
              <Button
                className="h-6 w-6"
                onClick={toggleComicDeleted}
                title="标记删除"
              >
                <Trash2
                  className={cn('h-4 w-4', comic.deleted && 'text-subtle/40')}
                />
              </Button>
              <Button
                className="h-6 w-6"
                onClick={toggleComicStarred}
                title="标记收藏"
              >
                <Star
                  className={cn(
                    'h-4 w-4',
                    comic.starred && 'text-love fill-gold/80',
                  )}
                />
              </Button>
            </>
          )}
        </div>

        <h3 className="min-w-0 truncate text-left" title={comic?.title}>
          {comic?.title}
        </h3>

        <span className="shrink-0 whitespace-nowrap">{pageStatusText}</span>
      </div>
      {viewMode === 'grid' ? (
        <div aria-label="图片列表" className="contents">
          <VirtuosoGrid
            key={`${comicId}:${gridStartForComic?.seq ?? 0}`}
            className="flex-1"
            data={images}
            initialTopMostItemIndex={gridStartForComic?.index ?? 0}
            itemContent={renderGridImage}
            listClassName="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))]"
            increaseViewportBy={600}
          />
        </div>
      ) : (
        <ComicStrip
          key={comicId}
          ref={stripRef}
          className="h-0 flex-auto"
          comicId={comicId}
          images={images}
          initialIndex={currentIndex}
          orientation="vertical"
          onCurrentIndexChange={trackStripIndex}
          onHover={setHoveredIndex}
          onDoubleClick={setPreviewIndex}
          onTags={updateComicImageTags}
        />
      )}

      <ImagePreviewOverlay
        comicId={comicId}
        images={images}
        active={previewActive}
        index={previewIndex}
        onIndexChange={setPreviewIndex}
        onClose={closePreview}
        onTags={updateComicImageTags}
      />
    </div>
  )
}
