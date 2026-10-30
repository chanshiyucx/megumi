import { Book as BookIcon, Star } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { VirtuosoGrid } from 'react-virtuoso'
import { Button } from '@/components/ui/button'
import { COVER_GRID_CLASS } from '@/components/ui/grid-item'
import { GridImage } from '@/components/ui/image-view'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { usePanelNav } from '@/hooks/use-panel-nav'
import {
  bookIdForChapterKey,
  chapterFavoriteKey,
  comicIdForImageKey,
  favoriteBooks,
  favoriteChapterGroups,
  favoriteComics,
  favoriteImageGroups,
  favoriteParagraphGroups,
  favoriteVideos,
  type FavoriteParagraphBlock,
  type FavoriteSources,
} from '@/lib/favorites'
import type { ParagraphFavorite } from '@/lib/remote-paragraphs'
import { cn, LIST_COLUMN_CLASS } from '@/lib/style'
import { useLibraryStore } from '@/store/library'
import { useParagraphsStore } from '@/store/paragraphs'
import { useProgressStore } from '@/store/progress'
import { useUIStore } from '@/store/ui'
import type {
  Book,
  Chapter,
  Comic,
  FavoriteCategory,
  Image,
  JumpRequest,
} from '@/types/library'
import { BookReader } from './book-reader'
import { ComicItem } from './comic-library'
import { ComicPanel } from './comic-panel'
import { VideoItem } from './video-library'
import { VideoPanel } from './video-panel'

const CATEGORIES: { key: FavoriteCategory; label: string }[] = [
  { key: 'comic', label: '漫画' },
  { key: 'image', label: '图片' },
  { key: 'book', label: '图书' },
  { key: 'chapter', label: '章节' },
  { key: 'paragraph', label: '段落' },
  { key: 'video', label: '视频' },
]

const NO_RETAINED: ReadonlySet<string> = new Set()

function useFavoriteSources(): FavoriteSources {
  const libraries = useLibraryStore((s) => s.libraries)
  const comics = useLibraryStore((s) => s.comics)
  const authors = useLibraryStore((s) => s.authors)
  const books = useLibraryStore((s) => s.books)
  const videos = useLibraryStore((s) => s.videos)
  const libraryComics = useLibraryStore((s) => s.libraryComics)
  const libraryAuthors = useLibraryStore((s) => s.libraryAuthors)
  const authorBooks = useLibraryStore((s) => s.authorBooks)
  const libraryVideos = useLibraryStore((s) => s.libraryVideos)
  const comicImages = useLibraryStore((s) => s.comicImages)
  const favoriteImageComicIds = useLibraryStore((s) => s.favoriteImageComicIds)
  const favoriteChapterBookIds = useLibraryStore(
    (s) => s.favoriteChapterBookIds,
  )

  return {
    libraries,
    comics,
    authors,
    books,
    videos,
    libraryComics,
    libraryAuthors,
    authorBooks,
    libraryVideos,
    comicImages,
    favoriteImageComicIds,
    favoriteChapterBookIds,
  }
}

function collectFavorites(src: FavoriteSources, retained: ReadonlySet<string>) {
  return {
    comic: favoriteComics(src, retained),
    image: favoriteImageGroups(src, retained),
    book: favoriteBooks(src, retained),
    chapter: favoriteChapterGroups(src, retained),
    video: favoriteVideos(src, retained),
  }
}

type Favorites = ReturnType<typeof collectFavorites>

// The keys the retained set tracks for a category, starred items only.
function starredKeys(category: FavoriteCategory, favorites: Favorites) {
  switch (category) {
    case 'comic':
      return favorites.comic.filter((c) => c.starred).map((c) => c.id)
    case 'image':
      return favorites.image.flatMap((g) =>
        g.images.filter((i) => i.starred).map((i) => i.path),
      )
    case 'book':
      return favorites.book.filter((b) => b.starred).map((b) => b.id)
    case 'chapter':
      return favorites.chapter.flatMap((g) =>
        g.chapters
          .filter((c) => c.starred)
          .map((c) => chapterFavoriteKey(g.book.id, c.lineIndex)),
      )
    case 'video':
      return favorites.video.filter((v) => v.starred).map((v) => v.id)
    // Unfavorited paragraphs are deleted, so they are kept separately.
    case 'paragraph':
      return []
  }
}

function countFavorites(
  favorites: Favorites,
  paragraphCount: number,
): Record<FavoriteCategory, number> {
  return {
    paragraph: paragraphCount,
    comic: favorites.comic.length,
    image: favorites.image.reduce((sum, g) => sum + g.images.length, 0),
    book: favorites.book.length,
    chapter: favorites.chapter.reduce((sum, g) => sum + g.chapters.length, 0),
    video: favorites.video.length,
  }
}

function EmptyState({ loading }: { loading: boolean }) {
  return (
    <div className="text-subtle flex flex-1 items-center justify-center text-xs">
      {loading ? <Spinner /> : '暂无收藏'}
    </div>
  )
}

function GroupHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="bg-base text-subtle sticky top-0 z-10 flex h-7 items-center justify-between gap-2 border-b px-3 text-xs">
      <span className="truncate" title={title}>
        {title}
      </span>
      <span className="shrink-0">{count}</span>
    </div>
  )
}

interface StarToggleProps {
  starred: boolean
  title: string
  onToggle: () => void
}

function StarToggle({ starred, title, onToggle }: StarToggleProps) {
  return (
    <button
      type="button"
      className="shrink-0"
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
    >
      <Star className={cn('h-4 w-4', starred && 'text-love fill-gold/80')} />
    </button>
  )
}

interface BookRowProps {
  book: Book
  authorName: string
  isSelected: boolean
  onSelect: (book: Book) => void
  onToggleStar: (book: Book) => void
}

function BookRow({
  book,
  authorName,
  isSelected,
  onSelect,
  onToggleStar,
}: BookRowProps) {
  const progress = useProgressStore((s) => s.books[book.id])

  return (
    <div
      className={cn(
        'hover:bg-overlay flex h-8 w-full cursor-pointer items-center gap-2 px-3 text-sm',
        isSelected && 'bg-overlay text-love',
        !book.starred && 'opacity-40',
      )}
      onClick={() => {
        onSelect(book)
      }}
    >
      <BookIcon className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={book.title}>
        {book.title}
      </span>
      <span className="text-subtle/60 max-w-24 shrink-0 truncate text-xs">
        {authorName}
      </span>
      {progress?.percent > 0 && (
        <span className="text-subtle/40 shrink-0 text-xs">
          {Math.round(progress.percent)}%
        </span>
      )}
      <StarToggle
        starred={book.starred}
        title="收藏图书"
        onToggle={() => {
          onToggleStar(book)
        }}
      />
    </div>
  )
}

export function FavoritesView() {
  const { readerVisible, middleClass, readerClass, openReader } = usePanelNav()
  const nav = useUIStore((s) => s.favoritesNav)
  const setFavoritesNav = useUIStore((s) => s.setFavoritesNav)
  const category = nav.category

  const src = useFavoriteSources()
  const comicImages = src.comicImages
  const bookChapterStatus = useLibraryStore((s) => s.bookChapterStatus)
  const getComicImages = useLibraryStore((s) => s.getComicImages)
  const getBookChapters = useLibraryStore((s) => s.getBookChapters)
  const updateComicTags = useLibraryStore((s) => s.updateComicTags)
  const updateComicImageTags = useLibraryStore((s) => s.updateComicImageTags)
  const updateBookTags = useLibraryStore((s) => s.updateBookTags)
  const updateBookChapterTags = useLibraryStore((s) => s.updateBookChapterTags)
  const updateVideoTags = useLibraryStore((s) => s.updateVideoTags)
  const paragraphs = useParagraphsStore((s) => s.paragraphs)
  const paragraphsStatus = useParagraphsStore((s) => s.status)
  const missingParagraphs = useParagraphsStore((s) => s.missing)
  const ensureParagraphsLoaded = useParagraphsStore((s) => s.ensureLoaded)
  const addParagraphs = useParagraphsStore((s) => s.addParagraphs)
  const removeParagraphs = useParagraphsStore((s) => s.removeParagraphs)

  const [retained, setRetained] = useState({
    category,
    keys: NO_RETAINED,
  })
  const [jumpRequest, setJumpRequest] = useState<JumpRequest>()
  const [playRequest, setPlayRequest] = useState(0)
  // Paragraphs unfavorited here are deleted from the store; keep them listed
  // (greyed, restorable) until the category changes.
  const [removedParagraphs, setRemovedParagraphs] = useState<
    Record<string, ParagraphFavorite>
  >({})
  const jumpSeqRef = useRef(0)

  const retainedKeys =
    retained.category === category ? retained.keys : NO_RETAINED
  const favorites = collectFavorites(src, retainedKeys)
  const paragraphGroups = favoriteParagraphGroups(
    src,
    paragraphs,
    removedParagraphs,
  )
  const counts = countFavorites(
    collectFavorites(src, NO_RETAINED),
    favoriteParagraphGroups(src, paragraphs, {}).reduce(
      (sum, group) => sum + group.blocks.length,
      0,
    ),
  )

  // Remember every starred item shown in this category so unstarring it keeps
  // it listed (greyed) until the category changes.
  const shownKeys = starredKeys(category, favorites)
  if (
    retained.category !== category ||
    shownKeys.some((key) => !retainedKeys.has(key))
  ) {
    setRetained({ category, keys: new Set([...retainedKeys, ...shownKeys]) })
  }

  // Page and chapter favorites live in per-comic / per-book details; fetch the
  // ones that hold any so the lists and counts are complete.
  useEffect(() => {
    for (const comicId of src.favoriteImageComicIds)
      void getComicImages(comicId)
  }, [getComicImages, src.favoriteImageComicIds])
  useEffect(() => {
    for (const bookId of src.favoriteChapterBookIds)
      void getBookChapters(bookId)
  }, [getBookChapters, src.favoriteChapterBookIds])

  useEffect(() => {
    void ensureParagraphsLoaded()
  }, [ensureParagraphsLoaded])
  const paragraphsLoading =
    paragraphsStatus === 'idle' || paragraphsStatus === 'loading'

  const imagesLoading = src.favoriteImageComicIds.some((id) => {
    const status = comicImages[id]?.status
    return status === 'idle' || status === 'loading'
  })
  const chaptersLoading = src.favoriteChapterBookIds.some((id) => {
    const status = bookChapterStatus[id]
    return status === undefined || status === 'idle' || status === 'loading'
  })

  const nextJump = (id: string, index: number, paragraphId?: string) => {
    jumpSeqRef.current += 1
    setJumpRequest({ id, index, seq: jumpSeqRef.current, paragraphId })
  }

  const selectCategory = (next: FavoriteCategory) => {
    if (next === category) return
    setJumpRequest(undefined)
    setRemovedParagraphs({})
    setFavoritesNav({ category: next })
  }

  const selectComic = (comicId: string) => {
    setJumpRequest(undefined)
    setFavoritesNav({ comicId })
    openReader()
  }

  const selectImage = (comic: Comic, image: Image) => {
    setFavoritesNav({ imageKey: image.path })
    nextJump(comic.id, image.index)
    openReader()
  }

  const selectBook = (book: Book) => {
    setJumpRequest(undefined)
    setFavoritesNav({ bookId: book.id })
    openReader()
  }

  const selectChapter = (book: Book, chapter: Chapter) => {
    setFavoritesNav({
      chapterKey: chapterFavoriteKey(book.id, chapter.lineIndex),
    })
    nextJump(book.id, chapter.lineIndex)
    openReader()
  }

  // A block is selected and jumped to through its first paragraph.
  const selectParagraphBlock = (block: FavoriteParagraphBlock, book?: Book) => {
    const [first] = block.paragraphs
    setFavoritesNav({ paragraphId: first.id })
    if (!book) return
    nextJump(book.id, first.lineIndex, first.id)
    openReader()
  }

  // Unfavorites (or restores) every paragraph of the block together.
  const toggleParagraphBlock = (block: FavoriteParagraphBlock) => {
    const ids = block.paragraphs.map(({ id }) => id)
    if (block.starred) {
      setRemovedParagraphs((removed) => ({
        ...removed,
        ...Object.fromEntries(block.paragraphs.map((p) => [p.id, p])),
      }))
      void removeParagraphs(ids)
      return
    }
    setRemovedParagraphs((removed) => {
      const rest = { ...removed }
      for (const id of ids) delete rest[id]
      return rest
    })
    void addParagraphs(block.paragraphs)
  }

  const selectVideo = (videoId: string) => {
    setFavoritesNav({ videoId })
    setPlayRequest((request) => request + 1)
    openReader()
  }

  const renderList = () => {
    switch (category) {
      case 'comic':
        return favorites.comic.length ? (
          <div aria-label="收藏漫画" className="contents">
            <VirtuosoGrid
              className="flex-1"
              data={favorites.comic}
              itemContent={(_index, comic) => (
                <div className={cn(!comic.starred && 'opacity-40')}>
                  <ComicItem
                    comic={comic}
                    isSelected={nav.comicId === comic.id}
                    onClick={selectComic}
                    onTags={updateComicTags}
                  />
                </div>
              )}
              listClassName={COVER_GRID_CLASS}
              increaseViewportBy={600}
            />
          </div>
        ) : (
          <EmptyState loading={false} />
        )

      case 'image':
        return favorites.image.length ? (
          <ScrollArea aria-label="收藏图片" viewportClassName="h-0 flex-1">
            {favorites.image.map(({ comic, images }) => (
              <section key={comic.id}>
                <GroupHeader title={comic.title} count={images.length} />
                <div className={COVER_GRID_CLASS}>
                  {images.map((image) => (
                    <div
                      key={image.path}
                      className={cn(!image.starred && 'opacity-40')}
                    >
                      <GridImage
                        comicId={comic.id}
                        image={image}
                        isSelected={nav.imageKey === image.path}
                        revealTags
                        onClick={() => {
                          selectImage(comic, image)
                        }}
                        onTags={updateComicImageTags}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ))}
            {imagesLoading && (
              <div className="flex justify-center py-3">
                <Spinner />
              </div>
            )}
          </ScrollArea>
        ) : (
          <EmptyState loading={imagesLoading} />
        )

      case 'book':
        return favorites.book.length ? (
          <ScrollArea aria-label="收藏图书" viewportClassName="h-0 flex-1">
            {favorites.book.map((book) => (
              <BookRow
                key={book.id}
                book={book}
                authorName={src.authors[book.authorId]?.name ?? ''}
                isSelected={nav.bookId === book.id}
                onSelect={selectBook}
                onToggleStar={(target) =>
                  void updateBookTags(target.id, { starred: !target.starred })
                }
              />
            ))}
          </ScrollArea>
        ) : (
          <EmptyState loading={false} />
        )

      case 'chapter':
        return favorites.chapter.length ? (
          <ScrollArea aria-label="收藏章节" viewportClassName="h-0 flex-1">
            {favorites.chapter.map(({ book, chapters }) => (
              <section key={book.id}>
                <GroupHeader title={book.title} count={chapters.length} />
                {chapters.map((chapter) => {
                  const key = chapterFavoriteKey(book.id, chapter.lineIndex)
                  return (
                    <div
                      key={key}
                      className={cn(
                        'hover:bg-overlay flex h-8 w-full cursor-pointer items-center gap-2 px-3 text-sm',
                        nav.chapterKey === key && 'bg-overlay text-love',
                        !chapter.starred && 'opacity-40',
                      )}
                      onClick={() => {
                        selectChapter(book, chapter)
                      }}
                    >
                      <span
                        className="min-w-0 flex-1 truncate"
                        title={chapter.title}
                      >
                        {chapter.title}
                      </span>
                      <StarToggle
                        starred={chapter.starred}
                        title="收藏章节"
                        onToggle={() =>
                          void updateBookChapterTags(
                            book.id,
                            chapter.lineIndex,
                            { starred: !chapter.starred },
                          )
                        }
                      />
                    </div>
                  )
                })}
              </section>
            ))}
            {chaptersLoading && (
              <div className="flex justify-center py-3">
                <Spinner />
              </div>
            )}
          </ScrollArea>
        ) : (
          <EmptyState loading={chaptersLoading} />
        )

      case 'paragraph':
        return paragraphGroups.length ? (
          <ScrollArea aria-label="收藏段落" viewportClassName="h-0 flex-1">
            {paragraphGroups.map(({ bookTitle, book, blocks }) => (
              <section key={bookTitle}>
                <GroupHeader
                  title={book ? bookTitle : `${bookTitle}（图书不存在）`}
                  count={blocks.length}
                />
                {blocks.map((block) => {
                  const [first] = block.paragraphs
                  const isSelected = block.paragraphs.some(
                    ({ id }) => id === nav.paragraphId,
                  )
                  const missingCount = book
                    ? block.paragraphs.filter(({ id }) => missingParagraphs[id])
                        .length
                    : 0
                  const text = block.paragraphs.map((p) => p.text).join('\n')
                  return (
                    <div
                      key={first.id}
                      className={cn(
                        'hover:bg-overlay flex w-full cursor-pointer items-start gap-2 px-3 py-2 text-sm',
                        isSelected && 'bg-overlay',
                        !block.starred && 'opacity-40',
                      )}
                      onClick={() => {
                        selectParagraphBlock(block, book)
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <p
                          className={cn(
                            'line-clamp-3 font-serif leading-relaxed whitespace-pre-line',
                            isSelected && 'text-love',
                          )}
                          title={text}
                        >
                          {text}
                        </p>
                        <div className="text-subtle/60 mt-1 flex gap-2 text-xs">
                          {first.chapterTitle && (
                            <span className="truncate">
                              {first.chapterTitle}
                            </span>
                          )}
                          {block.paragraphs.length > 1 && (
                            <span className="shrink-0">
                              {block.paragraphs.length} 段
                            </span>
                          )}
                          {missingCount > 0 && (
                            <span className="text-love shrink-0">
                              {block.paragraphs.length > 1
                                ? `${missingCount} 段原文已变更`
                                : '原文已变更'}
                            </span>
                          )}
                        </div>
                      </div>
                      <StarToggle
                        starred={block.starred}
                        title="收藏段落"
                        onToggle={() => {
                          toggleParagraphBlock(block)
                        }}
                      />
                    </div>
                  )
                })}
              </section>
            ))}
          </ScrollArea>
        ) : (
          <EmptyState loading={paragraphsLoading} />
        )

      case 'video':
        return favorites.video.length ? (
          <VirtuosoGrid
            aria-label="收藏视频"
            className="flex-1"
            data={favorites.video}
            itemContent={(_index, video) => (
              <div className={cn(!video.starred && 'opacity-40')}>
                <VideoItem
                  video={video}
                  isSelected={nav.videoId === video.id}
                  onClick={selectVideo}
                  onTags={updateVideoTags}
                />
              </div>
            )}
            listClassName={COVER_GRID_CLASS}
            increaseViewportBy={600}
          />
        ) : (
          <EmptyState loading={false} />
        )
    }
  }

  const renderPanel = () => {
    switch (category) {
      case 'comic':
      case 'image': {
        const comicId =
          category === 'comic'
            ? (nav.comicId ?? '')
            : nav.imageKey
              ? (comicIdForImageKey(nav.imageKey, src.comics) ?? '')
              : ''
        return (
          <ComicPanel
            key={category}
            comicId={comicId}
            className={readerClass}
            readerVisible={readerVisible}
            jumpRequest={jumpRequest}
          />
        )
      }

      case 'book':
      case 'chapter':
      case 'paragraph': {
        const bookId =
          category === 'book'
            ? (nav.bookId ?? '')
            : category === 'chapter'
              ? nav.chapterKey
                ? bookIdForChapterKey(nav.chapterKey)
                : ''
              : (paragraphGroups.find((group) =>
                  group.blocks.some((block) =>
                    block.paragraphs.some(({ id }) => id === nav.paragraphId),
                  ),
                )?.book?.id ?? '')
        return (
          <div className={cn('min-h-0 min-w-0 flex-1', readerClass)}>
            {bookId && (
              <BookReader
                key={category}
                bookId={bookId}
                surface="library"
                showReading
                jumpRequest={jumpRequest}
              />
            )}
          </div>
        )
      }

      case 'video':
        return (
          <VideoPanel
            videoId={nav.videoId ?? ''}
            className={readerClass}
            readerVisible={readerVisible}
            playRequest={playRequest}
          />
        )
    }
  }

  // Every category uses the shared list column width (the same as every
  // library), so switching tabs never shifts the layout.
  return (
    <div className="flex h-full w-full">
      <div
        className={cn(
          'min-h-0 flex-col border-r',
          LIST_COLUMN_CLASS,
          middleClass,
        )}
      >
        <div
          role="tablist"
          aria-label="收藏分类"
          className="bg-base text-subtle flex h-8 shrink-0 items-center border-b text-xs"
        >
          {CATEGORIES.map(({ key, label }) => (
            <Button
              key={key}
              role="tab"
              aria-selected={category === key}
              className={cn(
                'h-full flex-1 gap-1 rounded-none px-1 text-xs',
                category === key && 'bg-overlay text-love',
                !counts[key] && category !== key && 'text-subtle/40',
              )}
              onClick={() => {
                selectCategory(key)
              }}
            >
              <span>{label}</span>
              {counts[key] > 0 && <span>{counts[key]}</span>}
            </Button>
          ))}
        </div>
        {renderList()}
      </div>

      {renderPanel()}
    </div>
  )
}
