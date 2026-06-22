import type { Author, Book, Comic, Image, Library } from '@/types/library'
import { chapterTagId, fetchRemoteTags, type RemoteTags } from '@/lib/tags'

interface PageManifest {
  key: string
  thumbnailKey: string
  width: number
  height: number
  mtimeMs: number
}

interface ComicSummaryManifest {
  title: string
  coverKey?: string
}

interface ComicManifest {
  title: string
  pages: PageManifest[]
}

interface BookManifest {
  title: string
  key: string
}

interface ChapterManifest {
  title: string
  lineIndex: number
}

interface BookDetailManifest {
  title: string
  lineCount: number
  chapters: ChapterManifest[]
}

interface AuthorManifest {
  name: string
  books: BookManifest[]
}

type LibraryManifest =
  | {
      kind: 'comic'
      title: string
      comics: ComicSummaryManifest[]
    }
  | {
      kind: 'book'
      title: string
      authors: AuthorManifest[]
    }

interface Manifest {
  schemaVersion: 3
  generatedAt: string
  libraries: LibraryManifest[]
}

export interface RemoteCatalog {
  libraries: Library[]
  comics: Comic[]
  authors: Author[]
  books: Book[]
  comicSources: Record<string, RemoteComicSource>
  bookSources: Record<string, RemoteBookSource>
  tags: RemoteTags
}

export interface FetchRemoteCatalogOptions {
  allowEmptyTagsFallback?: boolean
  cache?: RequestCache
}

interface FetchRemoteDetailOptions {
  cache?: RequestCache
  tags?: RemoteTags
}

export interface RemoteComicSource {
  detailUrl: string
  manifestUrl: string
}

export interface RemoteBookSource {
  detailUrl: string
  title: string
}

function assetUrl(
  manifestUrl: string,
  key: string,
) {
  return new URL(key, manifestUrl).toString()
}

function versionedAssetUrl(
  manifestUrl: string,
  key: string,
  mtimeMs: number,
) {
  const url = new URL(assetUrl(manifestUrl, key))
  url.searchParams.set('v', String(mtimeMs))
  return url.toString()
}

function detailKeyFor(path: string) {
  return `manifests/${stripExtension(path)}.json`
}

function stripExtension(path: string) {
  return path.replace(/\.[^/.]+$/, '')
}

function filenameFromKey(key: string) {
  return key.split('/').pop() ?? key
}

async function fetchTagsOrEmpty(cache: RequestCache = 'no-cache'): Promise<RemoteTags> {
  try {
    return await fetchRemoteTags({ cache })
  } catch (error) {
    console.error('Failed to fetch tags:', error)
    return {
      version: 1,
      comics: {},
      books: {},
      images: {},
      chapters: {},
    }
  }
}

export async function fetchRemoteCatalog({
  allowEmptyTagsFallback = true,
  cache = 'no-cache',
}: FetchRemoteCatalogOptions = {}): Promise<RemoteCatalog> {
  const manifestUrl = process.env.NEXT_PUBLIC_MEGUMI_MANIFEST_URL
  if (!manifestUrl) {
    throw new Error('NEXT_PUBLIC_MEGUMI_MANIFEST_URL is not configured')
  }

  const [response, tags] = await Promise.all([
    fetch(manifestUrl, { cache }),
    allowEmptyTagsFallback ? fetchTagsOrEmpty(cache) : fetchRemoteTags({ cache }),
  ])
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${manifestUrl}`)
  }

  const manifest = (await response.json()) as Manifest
  const libraries: Library[] = []
  const comics: Comic[] = []
  const authors: Author[] = []
  const books: Book[] = []
  const comicSources: Record<string, RemoteComicSource> = {}
  const bookSources: Record<string, RemoteBookSource> = {}

  manifest.libraries.forEach((sourceLibrary, sortOrder) => {
    const libraryId = sourceLibrary.title
    libraries.push({
      id: libraryId,
      name: sourceLibrary.title,
      path: sourceLibrary.title,
      type: sourceLibrary.kind,
      sortOrder,
    })

    if (sourceLibrary.kind === 'comic') {
      for (const sourceComic of sourceLibrary.comics) {
        const comicId = `${libraryId}/${sourceComic.title}`
        comicSources[comicId] = {
          detailUrl: assetUrl(manifestUrl, detailKeyFor(comicId)),
          manifestUrl,
        }
        const comicTags = tags.comics[sourceComic.title] ?? {}
        comics.push({
          id: comicId,
          title: sourceComic.title,
          path: comicId,
          cover: sourceComic.coverKey
            ? assetUrl(manifestUrl, sourceComic.coverKey)
            : '',
          libraryId,
          starred: Boolean(comicTags.starred),
          deleted: Boolean(comicTags.deleted),
        })
      }
      return
    }

    for (const sourceAuthor of sourceLibrary.authors) {
      const authorId = `${libraryId}/${sourceAuthor.name}`
      authors.push({
        id: authorId,
        name: sourceAuthor.name,
        path: authorId,
        libraryId,
        bookCount: sourceAuthor.books.length,
      })

      for (const sourceBook of sourceAuthor.books) {
        const bookId = stripExtension(sourceBook.key)
        const bookTags = tags.books[sourceBook.title] ?? {}
        bookSources[bookId] = {
          detailUrl: assetUrl(manifestUrl, detailKeyFor(bookId)),
          title: sourceBook.title,
        }
        books.push({
          id: bookId,
          title: sourceBook.title,
          path: assetUrl(manifestUrl, sourceBook.key),
          authorId,
          libraryId,
          starred: Boolean(bookTags.starred),
          deleted: Boolean(bookTags.deleted),
          chapters: [],
        })
      }
    }
  })

  return { libraries, comics, authors, books, comicSources, bookSources, tags }
}

export async function fetchRemoteBookChapters(
  source: RemoteBookSource,
  { cache = 'no-cache', tags }: FetchRemoteDetailOptions = {},
): Promise<Book['chapters']> {
  const [response, resolvedTags] = await Promise.all([
    fetch(source.detailUrl, { cache }),
    tags ? Promise.resolve(tags) : fetchTagsOrEmpty(cache),
  ])
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${source.detailUrl}`)
  }

  const book = (await response.json()) as BookDetailManifest
  return book.chapters.map((chapter) => ({
    ...chapter,
    starred: Boolean(
      resolvedTags.chapters[chapterTagId(source.title, chapter.title)]
        ?.starred,
    ),
  }))
}

export async function fetchRemoteComicImages(
  source: RemoteComicSource,
  { cache = 'no-cache', tags }: FetchRemoteDetailOptions = {},
): Promise<Image[]> {
  const [response, resolvedTags] = await Promise.all([
    fetch(source.detailUrl, { cache }),
    tags ? Promise.resolve(tags) : fetchTagsOrEmpty(cache),
  ])
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${source.detailUrl}`)
  }

  const comic = (await response.json()) as ComicManifest
  return comic.pages.map<Image>((page, index) => ({
    path: page.key,
    url: versionedAssetUrl(
      source.manifestUrl,
      page.key,
      page.mtimeMs,
    ),
    thumbnail: versionedAssetUrl(
      source.manifestUrl,
      page.thumbnailKey,
      page.mtimeMs,
    ),
    filename: filenameFromKey(page.key),
    starred: Boolean(resolvedTags.images[page.key]?.starred),
    deleted: Boolean(resolvedTags.images[page.key]?.deleted),
    width: page.width,
    height: page.height,
    index,
  }))
}
