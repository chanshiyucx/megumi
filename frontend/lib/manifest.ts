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
  coverKey: string
  coverMtimeMs: number
  detailVersion: string
}

interface ComicManifest {
  schemaVersion: 4
  title: string
  pages: PageManifest[]
}

interface BookManifest {
  title: string
  key: string
  mtimeMs: number
}

interface ChapterManifest {
  title: string
  lineIndex: number
}

interface BookDetailManifest {
  schemaVersion: 4
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
  schemaVersion: 4
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
}

interface FetchRemoteDetailOptions {
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
  const encodedKey = key.split('/').map(encodeURIComponent).join('/')
  return new URL(encodedKey, manifestUrl).toString()
}

function versionedAssetUrl(
  manifestUrl: string,
  key: string,
  version: string | number,
) {
  const url = new URL(assetUrl(manifestUrl, key))
  url.searchParams.set('v', String(version))
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

async function fetchTagsOrEmpty(): Promise<RemoteTags> {
  try {
    return await fetchRemoteTags()
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
}: FetchRemoteCatalogOptions = {}): Promise<RemoteCatalog> {
  const manifestUrl = process.env.NEXT_PUBLIC_MEGUMI_MANIFEST_URL
  if (!manifestUrl) {
    throw new Error('NEXT_PUBLIC_MEGUMI_MANIFEST_URL is not configured')
  }

  const [response, tags] = await Promise.all([
    fetch(manifestUrl, { cache: 'no-cache' }),
    allowEmptyTagsFallback ? fetchTagsOrEmpty() : fetchRemoteTags(),
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
          detailUrl: versionedAssetUrl(
            manifestUrl,
            detailKeyFor(comicId),
            sourceComic.detailVersion,
          ),
          manifestUrl,
        }
        const comicTags = tags.comics[sourceComic.title] ?? {}
        comics.push({
          id: comicId,
          title: sourceComic.title,
          path: comicId,
          cover: versionedAssetUrl(
            manifestUrl,
            sourceComic.coverKey,
            sourceComic.coverMtimeMs,
          ),
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
          detailUrl: versionedAssetUrl(
            manifestUrl,
            detailKeyFor(bookId),
            sourceBook.mtimeMs,
          ),
          title: sourceBook.title,
        }
        books.push({
          id: bookId,
          title: sourceBook.title,
          path: versionedAssetUrl(
            manifestUrl,
            sourceBook.key,
            sourceBook.mtimeMs,
          ),
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
  { tags }: FetchRemoteDetailOptions = {},
): Promise<Book['chapters']> {
  const [response, resolvedTags] = await Promise.all([
    fetch(source.detailUrl),
    tags ? Promise.resolve(tags) : fetchTagsOrEmpty(),
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
  { tags }: FetchRemoteDetailOptions = {},
): Promise<Image[]> {
  const [response, resolvedTags] = await Promise.all([
    fetch(source.detailUrl),
    tags ? Promise.resolve(tags) : fetchTagsOrEmpty(),
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
