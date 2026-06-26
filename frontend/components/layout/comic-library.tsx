import { Grid2x2, Rows2, Star, StepForward, Trash2 } from 'lucide-react'
import { useRef } from 'react'
import { VirtuosoGrid } from 'react-virtuoso'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import { ComicStrip, type ComicStripHandle } from '@/components/ui/comic-strip'
import { GridItem } from '@/components/ui/grid-item'
import { GridImage, ImagePreviewOverlay } from '@/components/ui/image-view'
import { useComicReadingSession } from '@/hooks/use-comic-reading-session'
import { usePanelNav } from '@/hooks/use-panel-nav'
import { selectOrderedComicsForLibrary } from '@/lib/library-queries'
import { cn } from '@/lib/style'
import { useLibraryStore } from '@/store/library'
import { useProgressStore } from '@/store/progress'
import { useUIStore } from '@/store/ui'
import type { Comic, FileTags, Image, Library } from '@/types/library'

interface ComicItemProps {
  comic: Comic
  isSelected: boolean
  onClick: (id: string) => void
  onTags: (id: string, tags: FileTags) => Promise<void>
}

function ComicItem({
  comic,
  isSelected,
  onClick,
  onTags,
}: ComicItemProps) {
  const progress = useProgressStore((s) => s.comics[comic.id])

  // A starred cover shows a star badge, and a deleted one greys out and shows a
  // trash badge; tapping either badge toggles that tag.
  return (
    <GridItem
      title={comic.title}
      cover={comic.cover}
      starred={comic.starred}
      deleted={comic.deleted}
      isSelected={isSelected}
      progress={progress}
      onClick={() => {
        onClick(comic.id)
      }}
      onStar={() => void onTags(comic.id, { starred: !comic.starred })}
      onDelete={() => void onTags(comic.id, { deleted: !comic.deleted })}
    />
  )
}

interface ComicLibraryProps {
  selectedLibrary: Library
}

export function ComicLibrary({ selectedLibrary }: ComicLibraryProps) {
  const stripRef = useRef<ComicStripHandle>(null)
  const { readerVisible, middleClass, readerClass, openReader } = usePanelNav()

  const viewMode = useUIStore((s) => s.comicLibraryViewMode)
  const setViewMode = useUIStore((s) => s.setComicLibraryViewMode)
  const setNavStatus = useUIStore((s) => s.setNavStatus)
  const updateComicTags = useLibraryStore((s) => s.updateComicTags)

  const comicId = useUIStore(
    (s) => s.navStatus[selectedLibrary.id]?.comicId ?? '',
  )
  const comics = useLibraryStore(
    useShallow((s) => selectOrderedComicsForLibrary(s, selectedLibrary.id)),
  )

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

  const handleSelectComic = (id: string) => {
    if (id !== comic?.id) {
      setNavStatus(selectedLibrary.id, { comicId: id })
    }
    openReader()
  }

  // Closing the preview syncs the reading position to the page the user flipped
  // to, scrolling the strip there when scroll mode is showing.
  const handlePreviewClose = () => {
    closePreview()
  }

  const pageStatusText = (() => {
    if (!comic) return ''
    if (images.length) return `${currentIndex + 1} / ${images.length}`
    if (comicImageStatus === 'failed') return '加载失败'
    if (comicImageStatus === 'empty') return '暂无图片'
    return '加载中'
  })()

  const renderComicItem = (_index: number, comic: Comic) => (
    <ComicItem
      comic={comic}
      isSelected={comicId === comic.id}
      onClick={handleSelectComic}
      onTags={updateComicTags}
    />
  )

  const renderGridImage = (_index: number, img: Image) => (
    <GridImage
      comicId={comicId}
      image={img}
      tagOnTap
      onDoubleClick={setPreviewIndex}
      onTags={updateComicImageTags}
    />
  )

  return (
    <div className="flex h-full w-full">
      <div className={cn('min-h-0 flex-1 flex-col border-r', middleClass)}>
        <div className="bg-base text-subtle flex h-8 items-center justify-end border-b px-3 text-xs">
          <span>COMICS ({comics.length})</span>
        </div>
        <div aria-label="漫画列表" className="contents">
          <VirtuosoGrid
            className="flex-1"
            data={comics}
            itemContent={renderComicItem}
            listClassName="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))]"
            increaseViewportBy={600}
          />
        </div>
      </div>

      <div className={cn('min-h-0 flex-1 flex-col', readerClass)}>
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
              key={comicId}
              className="flex-1"
              data={images}
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
      </div>

      <ImagePreviewOverlay
        comicId={comicId}
        images={images}
        active={previewActive}
        index={previewIndex}
        onIndexChange={setPreviewIndex}
        onClose={handlePreviewClose}
        onTags={updateComicImageTags}
      />
    </div>
  )
}
