import { ArrowDownAZ, CalendarArrowDown, CalendarArrowUp } from 'lucide-react'
import { VirtuosoGrid } from 'react-virtuoso'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import { COVER_GRID_CLASS, GridItem } from '@/components/ui/grid-item'
import { usePanelNav } from '@/hooks/use-panel-nav'
import { selectOrderedComicsForLibrary } from '@/lib/library-queries'
import { cn, LIST_COLUMN_CLASS } from '@/lib/style'
import { useLibraryStore } from '@/store/library'
import { useProgressStore } from '@/store/progress'
import { useUIStore } from '@/store/ui'
import type {
  Comic,
  ComicLibrarySortMode,
  FileTags,
  Library,
} from '@/types/library'
import { ComicPanel } from './comic-panel'

const NEXT_SORT_MODE: Record<ComicLibrarySortMode, ComicLibrarySortMode> = {
  'created-asc': 'created-desc',
  'created-desc': 'title',
  title: 'created-asc',
}

interface ComicItemProps {
  comic: Comic
  isSelected: boolean
  onClick: (id: string) => void
  onTags: (id: string, tags: FileTags) => Promise<void>
}

export function ComicItem({
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
  const { readerVisible, middleClass, readerClass, openReader } = usePanelNav()

  const sortMode = useUIStore((s) => s.comicLibrarySortMode)
  const setSortMode = useUIStore((s) => s.setComicLibrarySortMode)
  const setNavStatus = useUIStore((s) => s.setNavStatus)
  const updateComicTags = useLibraryStore((s) => s.updateComicTags)

  const comicId = useUIStore(
    (s) => s.navStatus[selectedLibrary.id]?.comicId ?? '',
  )
  const comics = useLibraryStore(
    useShallow((s) =>
      selectOrderedComicsForLibrary(s, selectedLibrary.id, sortMode),
    ),
  )

  const cycleSortMode = () => {
    setSortMode(NEXT_SORT_MODE[sortMode])
  }

  const handleSelectComic = (id: string) => {
    if (id !== comicId) {
      setNavStatus(selectedLibrary.id, { comicId: id })
    }
    openReader()
  }

  const renderComicItem = (_index: number, comic: Comic) => (
    <ComicItem
      comic={comic}
      isSelected={comicId === comic.id}
      onClick={handleSelectComic}
      onTags={updateComicTags}
    />
  )

  return (
    <div className="flex h-full w-full">
      <div
        className={cn(
          'min-h-0 flex-col border-r',
          LIST_COLUMN_CLASS,
          middleClass,
        )}
      >
        <div className="bg-base text-subtle flex h-8 items-center justify-between border-b px-3 text-xs">
          <Button
            aria-label="切换漫画排序"
            className="h-6 w-6"
            onClick={cycleSortMode}
          >
            {sortMode === 'created-asc' ? (
              <CalendarArrowDown className="h-4 w-4" />
            ) : sortMode === 'created-desc' ? (
              <CalendarArrowUp className="h-4 w-4" />
            ) : (
              <ArrowDownAZ className="h-4 w-4" />
            )}
          </Button>
          <span>COMICS ({comics.length})</span>
        </div>
        <div aria-label="漫画列表" className="contents">
          <VirtuosoGrid
            className="flex-1"
            data={comics}
            itemContent={renderComicItem}
            listClassName={COVER_GRID_CLASS}
            increaseViewportBy={600}
          />
        </div>
      </div>

      <ComicPanel
        comicId={comicId}
        className={readerClass}
        readerVisible={readerVisible}
      />
    </div>
  )
}
