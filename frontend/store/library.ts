import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import {
  fetchRemoteCatalog,
  fetchRemoteBookChapters,
  fetchRemoteComicImages,
  type RemoteCatalog,
  type RemoteBookSource,
  type RemoteComicSource,
} from '@/lib/manifest'
import { chapterTagId, patchRemoteTags } from '@/lib/tags'
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
  comicSources: Record<string, RemoteComicSource>
  bookSources: Record<string, RemoteBookSource>
  bookChapterStatus: Record<string, LoadStatus>
  loadStatus: LoadStatus
  loadError?: string
  hydrate: () => Promise<void>
  refreshLibrary: (libraryId: string) => Promise<void>
  removeLibrary: (id: string) => Promise<void>
  reorderLibrary: (orderedIds: string[]) => void
  getComicImages: (comicId: string) => Promise<Image[]>
  getBookChapters: (bookId: string) => Promise<Book['chapters']>
  updateBookTags: (bookId: string, tags: FileTags) => Promise<void>
  updateComicTags: (comicId: string, tags: FileTags) => Promise<void>
  updateComicImageTags: (
    comicId: string,
    imageKey: string,
    tags: FileTags,
  ) => Promise<void>
  updateBookChapterTags: (
    bookId: string,
    lineIndex: number,
    tags: FileTags,
  ) => Promise<void>
}

function applyFileTags(
  item: { starred: boolean; deleted: boolean },
  tags: FileTags,
) {
  if (tags.starred !== undefined) item.starred = tags.starred
  if (tags.deleted !== undefined) item.deleted = tags.deleted
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

  const comicImages: Record<string, ComicImage> = {}
  for (const comic of catalog.comics) {
    const comicId = comic.id
    comicImages[comicId] = {
      comicId,
      status: 'idle',
      images: [],
      timestamp: 0,
    }
  }

  const bookChapterStatus: Record<string, LoadStatus> = {}
  for (const book of catalog.books) {
    bookChapterStatus[book.id] = 'idle'
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
    comicSources: catalog.comicSources,
    bookSources: catalog.bookSources,
    bookChapterStatus,
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
    comicSources: {},
    bookSources: {},
    bookChapterStatus: {},
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

    refreshLibrary: async () => {},
    removeLibrary: async () => {},
    reorderLibrary: () => {},
    getBookChapters: async (bookId) => {
      const book = get().books[bookId]
      const source = get().bookSources[bookId]
      if (!book || !source) return []
      const status = get().bookChapterStatus[bookId] ?? 'idle'
      if (status === 'ready') return book.chapters
      if (status === 'loading') return book.chapters

      set((state) => {
        state.bookChapterStatus[bookId] = 'loading'
      })
      try {
        const chapters = await fetchRemoteBookChapters(source)
        set((state) => {
          const book = state.books[bookId]
          if (!book) return
          book.chapters = chapters
          state.bookChapterStatus[bookId] = 'ready'
        })
        return chapters
      } catch (error) {
        console.error(`Failed to fetch book chapters for ${bookId}:`, error)
        set((state) => {
          state.bookChapterStatus[bookId] = 'failed'
        })
        return []
      }
    },
    updateBookTags: async (bookId, tags) => {
      const previous = get().books[bookId]
      if (!previous) return
      const rollback = {
        starred: previous.starred,
        deleted: previous.deleted,
      }

      set((state) => {
        const book = state.books[bookId]
        if (book) applyFileTags(book, tags)
      })

      try {
        await patchRemoteTags({
          targetType: 'book',
          targetId: previous.title,
          tags,
        })
      } catch (error) {
        console.error(`Failed to update book tags for ${bookId}:`, error)
        set((state) => {
          const book = state.books[bookId]
          if (book) applyFileTags(book, rollback)
        })
      }
    },
    updateComicTags: async (comicId, tags) => {
      const previous = get().comics[comicId]
      if (!previous) return
      const rollback = {
        starred: previous.starred,
        deleted: previous.deleted,
      }

      set((state) => {
        const comic = state.comics[comicId]
        if (comic) applyFileTags(comic, tags)
      })

      try {
        await patchRemoteTags({
          targetType: 'comic',
          targetId: previous.title,
          tags,
        })
      } catch (error) {
        console.error(`Failed to update comic tags for ${comicId}:`, error)
        set((state) => {
          const comic = state.comics[comicId]
          if (comic) applyFileTags(comic, rollback)
        })
      }
    },
    updateComicImageTags: async (comicId, imageKey, tags) => {
      const previous = get().comicImages[comicId]?.images.find(
        (image) => image.path === imageKey,
      )
      if (!previous) return
      const rollback = {
        starred: previous.starred,
        deleted: previous.deleted,
      }

      set((state) => {
        const image = state.comicImages[comicId]?.images.find(
          (item) => item.path === imageKey,
        )
        if (image) applyFileTags(image, tags)
      })

      try {
        await patchRemoteTags({ targetType: 'image', targetId: imageKey, tags })
      } catch (error) {
        console.error(`Failed to update image tags for ${imageKey}:`, error)
        set((state) => {
          const image = state.comicImages[comicId]?.images.find(
            (item) => item.path === imageKey,
          )
          if (image) applyFileTags(image, rollback)
        })
      }
    },
    updateBookChapterTags: async (bookId, lineIndex, tags) => {
      const book = get().books[bookId]
      const previous = book?.chapters.find(
        (chapter) => chapter.lineIndex === lineIndex,
      )
      if (!book || !previous) return
      const rollback = { starred: previous.starred }

      set((state) => {
        const chapter = state.books[bookId]?.chapters.find(
          (item) => item.lineIndex === lineIndex,
        )
        if (chapter && tags.starred !== undefined) {
          chapter.starred = tags.starred
        }
      })

      try {
        await patchRemoteTags({
          targetType: 'chapter',
          targetId: chapterTagId(book.title, previous.title),
          tags,
        })
      } catch (error) {
        console.error(
          `Failed to update chapter tags for ${bookId}:${lineIndex}:`,
          error,
        )
        set((state) => {
          const chapter = state.books[bookId]?.chapters.find(
            (item) => item.lineIndex === lineIndex,
          )
          if (chapter) chapter.starred = rollback.starred
        })
      }
    },

    getComicImages: async (comicId) => {
      const item = get().comicImages[comicId]
      const source = get().comicSources[comicId]
      if (!item || !source) return []
      if (item.status === 'ready' || item.status === 'empty') {
        set((state) => {
          state.comicImages[comicId].timestamp = Date.now()
        })
        return item.images
      }
      if (item.status === 'loading') return []

      set((state) => {
        state.comicImages[comicId].status = 'loading'
        state.comicImages[comicId].timestamp = Date.now()
        delete state.comicImages[comicId].error
      })
      try {
        const images = await fetchRemoteComicImages(source)
        set((state) => {
          const current = state.comicImages[comicId]
          if (!current) return
          current.status = images.length ? 'ready' : 'empty'
          current.images = images
          current.timestamp = Date.now()
        })
        return images
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`Failed to fetch comic manifest for ${comicId}:`, error)
        set((state) => {
          const current = state.comicImages[comicId]
          if (!current) return
          current.status = 'failed'
          current.error = message
          current.timestamp = Date.now()
        })
        return []
      }
    },
  })),
)
