import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { fetchRemoteCatalog, type RemoteCatalog } from '@/lib/manifest'
import { useUIStore } from '@/store/ui'
import type {
  Author,
  Book,
  Comic,
  ComicImage,
  FileTags,
  Image,
  Library,
} from '@/types/library'

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

type LoadStatus = 'idle' | 'loading' | 'ready' | 'failed'

interface LibraryState {
  libraries: Record<string, Library>
  comics: Record<string, Comic>
  authors: Record<string, Author>
  books: Record<string, Book>
  libraryComics: Record<string, string[]>
  libraryAuthors: Record<string, string[]>
  authorBooks: Record<string, string[]>
  comicImages: Record<string, ComicImage>
  loadStatus: LoadStatus
  loadError?: string
  hydrate: () => Promise<void>
  refreshLibrary: (libraryId: string) => Promise<void>
  removeLibrary: (id: string) => Promise<void>
  reorderLibrary: (orderedIds: string[]) => void
  getComicImages: (comicId: string) => Promise<Image[]>
  updateBookTags: (bookId: string, tags: FileTags) => Promise<void>
  updateComicTags: (comicId: string, tags: FileTags) => Promise<void>
  updateComicImageTags: (
    comicId: string,
    filename: string,
    tags: FileTags,
  ) => Promise<void>
}

function buildMaps(catalog: RemoteCatalog) {
  const libraries: Record<string, Library> = {}
  for (const library of catalog.libraries) libraries[library.id] = library

  const comics: Record<string, Comic> = {}
  const libraryComics: Record<string, string[]> = {}
  for (const comic of catalog.comics) {
    comics[comic.id] = comic
    ;(libraryComics[comic.libraryId] ??= []).push(comic.id)
  }

  const authors: Record<string, Author> = {}
  const libraryAuthors: Record<string, string[]> = {}
  for (const author of catalog.authors) {
    authors[author.id] = author
    ;(libraryAuthors[author.libraryId] ??= []).push(author.id)
  }

  const books: Record<string, Book> = {}
  const authorBooks: Record<string, string[]> = {}
  for (const book of catalog.books) {
    books[book.id] = book
    ;(authorBooks[book.authorId] ??= []).push(book.id)
  }

  for (const ids of Object.values(libraryComics))
    ids.sort((a, b) => collator.compare(comics[a].title, comics[b].title))
  for (const ids of Object.values(libraryAuthors))
    ids.sort((a, b) => collator.compare(authors[a].name, authors[b].name))
  for (const ids of Object.values(authorBooks))
    ids.sort((a, b) => collator.compare(books[a].title, books[b].title))

  const timestamp = Date.now()
  const comicImages: Record<string, ComicImage> = {}
  for (const [comicId, images] of Object.entries(catalog.comicImages)) {
    comicImages[comicId] = {
      comicId,
      status: images.length ? 'ready' : 'empty',
      images,
      timestamp,
    }
  }

  return {
    libraries,
    comics,
    authors,
    books,
    libraryComics,
    libraryAuthors,
    authorBooks,
    comicImages,
  }
}

export const useLibraryStore = create<LibraryState>()(
  immer((set, get) => ({
    libraries: {},
    comics: {},
    authors: {},
    books: {},
    libraryComics: {},
    libraryAuthors: {},
    authorBooks: {},
    comicImages: {},
    loadStatus: 'idle',

    hydrate: async () => {
      set((state) => {
        state.loadStatus = 'loading'
        delete state.loadError
      })
      try {
        const catalog = await fetchRemoteCatalog()
        const maps = buildMaps(catalog)
        set((state) => {
          Object.assign(state, maps)
          state.loadStatus = 'ready'
        })

        const ui = useUIStore.getState()
        if (!ui.selectedLibraryId || !maps.libraries[ui.selectedLibraryId]) {
          ui.setSelectedLibraryId(catalog.libraries[0]?.id ?? null)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('Failed to fetch manifest:', error)
        set((state) => {
          state.loadStatus = 'failed'
          state.loadError = message
        })
      }
    },

    // Mutation entry points remain in the UI for the next data-layer phase.
    refreshLibrary: async () => {},
    removeLibrary: async () => {},
    reorderLibrary: () => {},
    updateBookTags: async () => {},
    updateComicTags: async () => {},
    updateComicImageTags: async () => {},

    getComicImages: async (comicId) => {
      const item = get().comicImages[comicId]
      if (!item) return []
      set((state) => {
        state.comicImages[comicId].timestamp = Date.now()
      })
      return item.images
    },
  })),
)
