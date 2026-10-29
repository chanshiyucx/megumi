import type { ParagraphFavorite } from '@/lib/remote-paragraphs'
import type { RemoteTags } from '@/lib/tags'
import type {
  Author,
  Book,
  Chapter,
  Comic,
  ComicImage,
  Image,
  Library,
  LibraryType,
  Video,
} from '@/types/library'

export interface FavoriteSources {
  libraries: Record<string, Library>
  comics: Record<string, Comic>
  authors: Record<string, Author>
  books: Record<string, Book>
  videos: Record<string, Video>
  libraryComics: Record<string, string[]>
  libraryAuthors: Record<string, string[]>
  authorBooks: Record<string, string[]>
  libraryVideos: Record<string, string[]>
  comicImages: Record<string, ComicImage>
  favoriteImageComicIds: string[]
  favoriteChapterBookIds: string[]
}

export interface FavoriteImageGroup {
  comic: Comic
  images: Image[]
}

export interface FavoriteChapterGroup {
  book: Book
  chapters: Chapter[]
}

// A run of favorited paragraphs shown as one entry.
export interface FavoriteParagraphBlock {
  // In reading order; the block's identity is its first paragraph's id.
  paragraphs: ParagraphFavorite[]
  // False for a block unfavorited in this session (listed for restoring).
  starred: boolean
}

export interface FavoriteParagraphGroup {
  bookTitle: string
  // Undefined when no book with that title exists any more.
  book?: Book
  blocks: FavoriteParagraphBlock[]
}

// Items unstarred while the favorites view is open stay listed (greyed) until
// the category changes, so a mis-tap can be undone in place.
type Retained = ReadonlySet<string>

export function chapterFavoriteKey(bookId: string, lineIndex: number) {
  return `${bookId}#${lineIndex}`
}

export function bookIdForChapterKey(chapterKey: string) {
  return chapterKey.slice(0, chapterKey.lastIndexOf('#'))
}

/** The comic a page key belongs to: the nearest parent directory that is one. */
export function comicIdForImageKey(
  imageKey: string,
  comics: Record<string, Comic>,
) {
  let dir = imageKey
  while (dir.includes('/')) {
    dir = dir.slice(0, dir.lastIndexOf('/'))
    if (comics[dir]) return dir
  }
  return undefined
}

export function collectFavoriteImageComicIds(
  tags: RemoteTags,
  comics: Record<string, Comic>,
) {
  const ids = new Set<string>()
  for (const [imageKey, imageTags] of Object.entries(tags.images)) {
    if (!imageTags.starred) continue
    const comicId = comicIdForImageKey(imageKey, comics)
    if (comicId) ids.add(comicId)
  }
  return [...ids]
}

/** Chapter tags are keyed `书名:章节名`; either half may itself contain ':'. */
export function collectFavoriteChapterBookIds(
  tags: RemoteTags,
  books: Record<string, Book>,
) {
  const bookIdByTitle = new Map<string, string>()
  for (const book of Object.values(books))
    bookIdByTitle.set(book.title, book.id)

  const ids = new Set<string>()
  for (const [chapterKey, chapterTags] of Object.entries(tags.chapters)) {
    if (!chapterTags.starred) continue
    let split = chapterKey.indexOf(':')
    while (split !== -1) {
      const bookId = bookIdByTitle.get(chapterKey.slice(0, split))
      if (bookId) {
        ids.add(bookId)
        break
      }
      split = chapterKey.indexOf(':', split + 1)
    }
  }
  return [...ids]
}

function orderedLibraryIds(
  libraries: Record<string, Library>,
  type: LibraryType,
) {
  return Object.values(libraries)
    .filter((library) => library.type === type)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((library) => library.id)
}

function orderedComics(src: FavoriteSources) {
  return orderedLibraryIds(src.libraries, 'comic').flatMap((libraryId) =>
    (src.libraryComics[libraryId] ?? []).map((id) => src.comics[id]),
  )
}

function orderedBooks(src: FavoriteSources) {
  return orderedLibraryIds(src.libraries, 'book').flatMap((libraryId) =>
    (src.libraryAuthors[libraryId] ?? []).flatMap((authorId) =>
      (src.authorBooks[authorId] ?? []).map((id) => src.books[id]),
    ),
  )
}

export function favoriteComics(src: FavoriteSources, retained: Retained) {
  return orderedComics(src).filter(
    (comic) => comic.starred || retained.has(comic.id),
  )
}

export function favoriteBooks(src: FavoriteSources, retained: Retained) {
  return orderedBooks(src).filter(
    (book) => book.starred || retained.has(book.id),
  )
}

export function favoriteVideos(src: FavoriteSources, retained: Retained) {
  return orderedLibraryIds(src.libraries, 'video')
    .flatMap((libraryId) =>
      (src.libraryVideos[libraryId] ?? []).map((id) => src.videos[id]),
    )
    .filter((video) => video.starred || retained.has(video.id))
}

export function favoriteImageGroups(
  src: FavoriteSources,
  retained: Retained,
): FavoriteImageGroup[] {
  const candidates = new Set(src.favoriteImageComicIds)
  return orderedComics(src)
    .filter((comic) => candidates.has(comic.id))
    .map((comic) => ({
      comic,
      images: (src.comicImages[comic.id]?.images ?? []).filter(
        (image) => image.starred || retained.has(image.path),
      ),
    }))
    .filter((group) => group.images.length)
}

export function favoriteChapterGroups(
  src: FavoriteSources,
  retained: Retained,
): FavoriteChapterGroup[] {
  const candidates = new Set(src.favoriteChapterBookIds)
  return orderedBooks(src)
    .filter((book) => candidates.has(book.id))
    .map((book) => ({
      book,
      chapters: book.chapters.filter(
        (chapter) =>
          chapter.starred ||
          retained.has(chapterFavoriteKey(book.id, chapter.lineIndex)),
      ),
    }))
    .filter((group) => group.chapters.length)
}

function byPosition(a: ParagraphFavorite, b: ParagraphFavorite) {
  return (
    a.lineIndex - b.lineIndex || a.createdAt.localeCompare(b.createdAt)
  )
}

/**
 * Splits one book's paragraphs into blocks: a paragraph joins the previous
 * block when it directly follows it, or was favorited in the same action
 * (same createdAt), which keeps a selection that spanned an illustration
 * together.
 */
function toBlocks(paragraphs: ParagraphFavorite[], starred: boolean) {
  const blocks: FavoriteParagraphBlock[] = []
  for (const paragraph of [...paragraphs].sort(byPosition)) {
    const block = blocks.at(-1)
    const last = block?.paragraphs.at(-1)
    if (
      block &&
      last &&
      (paragraph.lineIndex - last.lineIndex <= 1 ||
        paragraph.createdAt === last.createdAt)
    ) {
      block.paragraphs.push(paragraph)
    } else {
      blocks.push({ paragraphs: [paragraph], starred })
    }
  }
  return blocks
}

/**
 * Paragraph favorites grouped by book in library order (books that no longer
 * exist go last), with each book's paragraphs merged into blocks. `removed`
 * are entries unfavorited in this session, listed unstarred so they can be
 * restored in place.
 */
export function favoriteParagraphGroups(
  src: FavoriteSources,
  paragraphs: Record<string, ParagraphFavorite>,
  removed: Record<string, ParagraphFavorite>,
): FavoriteParagraphGroup[] {
  const byBook = new Map<
    string,
    { starred: ParagraphFavorite[]; removed: ParagraphFavorite[] }
  >()
  const bucket = (bookTitle: string) => {
    let entry = byBook.get(bookTitle)
    if (!entry) {
      entry = { starred: [], removed: [] }
      byBook.set(bookTitle, entry)
    }
    return entry
  }
  for (const paragraph of Object.values(paragraphs)) {
    bucket(paragraph.bookTitle).starred.push(paragraph)
  }
  for (const paragraph of Object.values(removed)) {
    if (!paragraphs[paragraph.id]) {
      bucket(paragraph.bookTitle).removed.push(paragraph)
    }
  }

  const books = new Map<string, { book: Book; order: number }>()
  orderedBooks(src).forEach((book, order) => {
    if (!books.has(book.title)) books.set(book.title, { book, order })
  })

  return [...byBook]
    .map(([bookTitle, entry]) => ({
      bookTitle,
      book: books.get(bookTitle)?.book,
      // Removed blocks stay apart from the live ones so restoring one brings
      // back exactly what was removed.
      blocks: [
        ...toBlocks(entry.starred, true),
        ...toBlocks(entry.removed, false),
      ].sort((a, b) => byPosition(a.paragraphs[0], b.paragraphs[0])),
    }))
    .sort(
      (a, b) =>
        (books.get(a.bookTitle)?.order ?? Infinity) -
          (books.get(b.bookTitle)?.order ?? Infinity) ||
        a.bookTitle.localeCompare(b.bookTitle),
    )
}
