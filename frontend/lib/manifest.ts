import type { Author, Book, Comic, Image, Library } from '@/types/library'

interface PageManifest {
  index: number
  filename: string
  key: string
  url: string
  thumbnailKey: string
  thumbnailUrl: string
  width: number
  height: number
  mtimeMs: number
}

interface ComicManifest {
  id: string
  title: string
  path: string
  coverThumbnailKey?: string
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
  comics: ComicManifest[]
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
  comicImages: Record<string, Image[]>
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

export async function fetchRemoteCatalog(): Promise<RemoteCatalog> {
  const manifestUrl = process.env.NEXT_PUBLIC_MEGUMI_MANIFEST_URL
  if (!manifestUrl) {
    throw new Error('NEXT_PUBLIC_MEGUMI_MANIFEST_URL is not configured')
  }

  const response = await fetch(manifestUrl, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${manifestUrl}`)
  }

  const manifest = (await response.json()) as Manifest
  const generatedAt = Date.parse(manifest.generatedAt) || 0
  const libraries: Library[] = []
  const comics: Comic[] = []
  const authors: Author[] = []
  const books: Book[] = []
  const comicImages: Record<string, Image[]> = {}

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
      const images = sourceComic.pages.map<Image>((page) => ({
        path: page.key,
        url: assetUrl(
          manifestUrl,
          manifest.publicBaseUrl,
          page.url,
          page.key,
        ),
        thumbnail: assetUrl(
          manifestUrl,
          manifest.publicBaseUrl,
          page.thumbnailUrl,
          page.thumbnailKey,
        ),
        filename: page.filename,
        starred: false,
        deleted: false,
        width: page.width,
        height: page.height,
        index: page.index,
      }))
      comicImages[sourceComic.id] = images

      const firstPage = sourceComic.pages[0]
      comics.push({
        id: sourceComic.id,
        title: sourceComic.title,
        path: sourceComic.path,
        cover: firstPage
          ? assetUrl(
              manifestUrl,
              manifest.publicBaseUrl,
              firstPage.thumbnailUrl,
              sourceComic.coverThumbnailKey || firstPage.thumbnailKey,
            )
          : '',
        libraryId: sourceLibrary.id,
        starred: false,
        deleted: false,
        pageCount: sourceComic.pageCount,
        createdAt: firstPage?.mtimeMs ?? generatedAt,
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
          starred: false,
          deleted: false,
          size: sourceBook.size,
          createdAt: sourceBook.mtimeMs,
        })
      }
    }
  })

  return { libraries, comics, authors, books, comicImages }
}
