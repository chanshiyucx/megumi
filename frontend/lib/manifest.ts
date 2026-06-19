import type { Author, Book, Comic, Image, Library } from '@/types/library'
import { chapterTagId, fetchRemoteTags, type RemoteTags } from '@/lib/tags'

interface PageManifest {
  filename: string
  key: string
  thumbnailKey: string
  width: number
  height: number
  mtimeMs: number
}

interface ComicSummaryManifest {
  id: string
  title: string
  path: string
  coverThumbnailKey?: string
  pageCount: number
  createdAt: number
  detailKey: string
}

interface ComicManifest {
  id: string
  title: string
  path: string
  pageCount: number
  pages: PageManifest[]
}

interface BookManifest {
  id: string
  title: string
  key: string
  url: string
  size: number
  mtimeMs: number
  chapters?: ChapterManifest[]
}

interface ChapterManifest {
  title: string
  lineIndex: number
}

interface AuthorManifest {
  id: string
  name: string
  path: string
  books: BookManifest[]
}

interface LibraryManifest {
  id: string
  title: string
  kind: 'book' | 'comic'
  path: string
  comics: ComicSummaryManifest[]
  authors: AuthorManifest[]
}

interface Manifest {
  generatedAt: string
  publicBaseUrl?: string | null
  libraries: LibraryManifest[]
}

export interface RemoteCatalog {
  libraries: Library[]
  comics: Comic[]
  authors: Author[]
  books: Book[]
  comicSources: Record<string, RemoteComicSource>
}

export interface RemoteComicSource {
  detailUrl: string
  manifestUrl: string
  publicBaseUrl?: string | null
}

function assetUrl(
  manifestUrl: string,
  publicBaseUrl: string | null | undefined,
  url: string | undefined,
  key: string,
) {
  const base = publicBaseUrl
    ? `${publicBaseUrl.replace(/\/$/, '')}/`
    : manifestUrl
  return new URL(url || key, base).toString()
}

function versionedAssetUrl(
  manifestUrl: string,
  publicBaseUrl: string | null | undefined,
  key: string,
  mtimeMs: number,
) {
  const url = new URL(assetUrl(manifestUrl, publicBaseUrl, undefined, key))
  url.searchParams.set('v', String(mtimeMs))
  return url.toString()
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

export async function fetchRemoteCatalog(): Promise<RemoteCatalog> {
  const manifestUrl = process.env.NEXT_PUBLIC_MEGUMI_MANIFEST_URL
  if (!manifestUrl) {
    throw new Error('NEXT_PUBLIC_MEGUMI_MANIFEST_URL is not configured')
  }

  const [response, tags] = await Promise.all([
    fetch(manifestUrl, { cache: 'no-store' }),
    fetchTagsOrEmpty(),
  ])
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${manifestUrl}`)
  }

  const manifest = (await response.json()) as Manifest
  const generatedAt = Date.parse(manifest.generatedAt) || 0
  const libraries: Library[] = []
  const comics: Comic[] = []
  const authors: Author[] = []
  const books: Book[] = []
  const comicSources: Record<string, RemoteComicSource> = {}

  manifest.libraries.forEach((sourceLibrary, sortOrder) => {
    libraries.push({
      id: sourceLibrary.id,
      name: sourceLibrary.title,
      path: sourceLibrary.path,
      type: sourceLibrary.kind,
      createdAt: generatedAt,
      sortOrder,
    })

    for (const sourceComic of sourceLibrary.comics) {
      comicSources[sourceComic.id] = {
        detailUrl: assetUrl(
          manifestUrl,
          manifest.publicBaseUrl,
          undefined,
          sourceComic.detailKey,
        ),
        manifestUrl,
        publicBaseUrl: manifest.publicBaseUrl,
      }
      const comicTags = tags.comics[sourceComic.id] ?? {}
      comics.push({
        id: sourceComic.id,
        title: sourceComic.title,
        path: sourceComic.path,
        cover: sourceComic.coverThumbnailKey
          ? versionedAssetUrl(
              manifestUrl,
              manifest.publicBaseUrl,
              sourceComic.coverThumbnailKey,
              sourceComic.createdAt,
            )
          : '',
        libraryId: sourceLibrary.id,
        starred: Boolean(comicTags.starred),
        deleted: Boolean(comicTags.deleted),
        pageCount: sourceComic.pageCount,
        createdAt: sourceComic.createdAt || generatedAt,
      })
    }

    for (const sourceAuthor of sourceLibrary.authors) {
      authors.push({
        id: sourceAuthor.id,
        name: sourceAuthor.name,
        path: sourceAuthor.path,
        libraryId: sourceLibrary.id,
        bookCount: sourceAuthor.books.length,
      })

      for (const sourceBook of sourceAuthor.books) {
        const bookTags = tags.books[sourceBook.id] ?? {}
        books.push({
          id: sourceBook.id,
          title: sourceBook.title,
          path: assetUrl(
            manifestUrl,
            manifest.publicBaseUrl,
            sourceBook.url,
            sourceBook.key,
          ),
          authorId: sourceAuthor.id,
          libraryId: sourceLibrary.id,
          starred: Boolean(bookTags.starred),
          deleted: Boolean(bookTags.deleted),
          size: sourceBook.size,
          createdAt: sourceBook.mtimeMs,
          chapters: (sourceBook.chapters ?? []).map((chapter) => ({
            ...chapter,
            starred: Boolean(
              tags.chapters[chapterTagId(sourceBook.id, chapter.lineIndex)]
                ?.starred,
            ),
          })),
        })
      }
    }
  })

  return { libraries, comics, authors, books, comicSources }
}

export async function fetchRemoteComicImages(
  source: RemoteComicSource,
): Promise<Image[]> {
  const [response, tags] = await Promise.all([
    fetch(source.detailUrl, { cache: 'no-store' }),
    fetchTagsOrEmpty(),
  ])
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${source.detailUrl}`)
  }

  const comic = (await response.json()) as ComicManifest
  return comic.pages.map<Image>((page, index) => ({
    path: page.key,
    url: versionedAssetUrl(
      source.manifestUrl,
      source.publicBaseUrl,
      page.key,
      page.mtimeMs,
    ),
    thumbnail: versionedAssetUrl(
      source.manifestUrl,
      source.publicBaseUrl,
      page.thumbnailKey,
      page.mtimeMs,
    ),
    filename: page.filename,
    starred: Boolean(tags.images[page.key]?.starred),
    deleted: Boolean(tags.images[page.key]?.deleted),
    width: page.width,
    height: page.height,
    index,
  }))
}
