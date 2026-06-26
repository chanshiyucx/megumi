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
import {
  applyFileTags,
  bookTagTarget,
  chapterTagTarget,
  comicTagTarget,
  commitTagUpdate,
  imageTagTarget,
  readRemoteTags,
  snapshotFileTags,
} from '@/lib/tag-actions'
import type { RemoteTags } from '@/lib/tags'
import { useUIStore } from '@/store/ui'
import { useTabsStore } from '@/store/tabs'
import type {
  Author,
  Book,
  Chapter,
  Comic,
  ComicImage,
  FileTags,
  Image,
  Library,
  LibraryType,
} from '@/types/library'

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

const LIBRARY_ORDER_STORAGE_KEY = 'megumi-library-order'
const comicImageLoads = new Map<string, Promise<Image[]>>()
const bookChapterLoads = new Map<string, Promise<Chapter[]>>()
let hydrateLoad: Promise<void> | null = null
let hydrateSeq = 0
let latestTags: RemoteTags | null = null

type LoadStatus = 'idle' | 'loading' | 'ready' | 'failed'

interface ResourceLoadOptions {
  force?: boolean
}

interface CurrentResource {
  type: LibraryType
  id: string
}

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
  bookRefreshTokens: Record<string, number>
  loadStatus: LoadStatus
  loadError?: string
  hydrate: () => Promise<void>
  refreshCurrentResource: () => Promise<void>
  reorderLibrary: (orderedIds: string[]) => void
  getComicImages: (
    comicId: string,
    options?: ResourceLoadOptions,
  ) => Promise<Image[]>
  getBookChapters: (
    bookId: string,
    options?: ResourceLoadOptions,
  ) => Promise<Book['chapters']>
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

function readStoredLibraryOrder() {
  if (typeof window === 'undefined') return []

  try {
    const raw = localStorage.getItem(LIBRARY_ORDER_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string')
      : []
  } catch (error) {
    console.error('Failed to read library order:', error)
    return []
  }
}

function writeStoredLibraryOrder(orderedIds: string[]) {
  if (typeof window === 'undefined') return

  try {
    localStorage.setItem(LIBRARY_ORDER_STORAGE_KEY, JSON.stringify(orderedIds))
  } catch (error) {
    console.error('Failed to save library order:', error)
  }
}

function normalizeLibraryOrder(
  libraries: Record<string, Library>,
  preferredOrder: string[],
) {
  const seen = new Set<string>()
  const orderedIds = preferredOrder.filter((id) => {
    if (!libraries[id] || seen.has(id)) return false
    seen.add(id)
    return true
  })
  const remainingIds = Object.values(libraries)
    .filter((library) => !seen.has(library.id))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((library) => library.id)

  return [...orderedIds, ...remainingIds]
}

function applyLibraryOrder(
  libraries: Record<string, Library>,
  preferredOrder: string[],
) {
  const orderedIds = normalizeLibraryOrder(libraries, preferredOrder)
  orderedIds.forEach((id, index) => {
    libraries[id].sortOrder = index
  })
  return orderedIds
}

function applyRemoteImageTags(images: Image[], catalog: RemoteCatalog) {
  for (const image of images) {
    const tags = readRemoteTags(catalog.tags, imageTagTarget(image.path))
    image.starred = Boolean(tags.starred)
    image.deleted = Boolean(tags.deleted)
  }
}

function applyRemoteChapterTags(book: Book, catalog: RemoteCatalog) {
  for (const chapter of book.chapters) {
    const tags = readRemoteTags(catalog.tags, chapterTagTarget(book, chapter))
    chapter.starred = Boolean(tags.starred)
  }
}

function buildMaps(
  catalog: RemoteCatalog,
  previous: LibraryState,
  invalidateDetails: boolean,
) {
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
    const previousBook = previous.books[book.id]
    if (previousBook?.chapters.length) {
      book.chapters = previousBook.chapters.map((chapter) => ({ ...chapter }))
      applyRemoteChapterTags(book, catalog)
    }
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
    const previousImages = previous.comicImages[comicId]
    if (previousImages) {
      const preservedImages = {
        ...previousImages,
        images: previousImages.images.map((image) => ({ ...image })),
      }
      applyRemoteImageTags(preservedImages.images, catalog)
      if (invalidateDetails) {
        preservedImages.status = 'idle'
        delete preservedImages.error
      }
      comicImages[comicId] = preservedImages
      continue
    }
    comicImages[comicId] = {
      comicId,
      status: 'idle',
      images: [],
    }
  }

  const bookChapterStatus: Record<string, LoadStatus> = {}
  for (const book of catalog.books) {
    const previousStatus = previous.bookChapterStatus[book.id] ?? 'idle'
    bookChapterStatus[book.id] =
      invalidateDetails && previousStatus !== 'idle'
        ? 'idle'
        : previousStatus
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

function pruneTabsForCatalog(
  comics: Record<string, Comic>,
  books: Record<string, Book>,
) {
  const invalidTabIds = useTabsStore
    .getState()
    .tabs.filter((tab) => !comics[tab.id] && !books[tab.id])
    .map((tab) => tab.id)

  for (const tabId of invalidTabIds) {
    useTabsStore.getState().removeTab(tabId)
  }

  const activeTab = useTabsStore.getState().activeTab
  if (activeTab && !comics[activeTab] && !books[activeTab]) {
    useTabsStore.getState().setActiveTab('')
  }
}

function resolveCurrentResource(state: LibraryState): CurrentResource | null {
  const { activeTab, tabs } = useTabsStore.getState()
  const active = tabs.find((tab) => tab.id === activeTab)
  if (active) return { type: active.type, id: active.id }

  const ui = useUIStore.getState()
  const selectedLibraryId = ui.selectedLibraryId
  if (!selectedLibraryId) return null

  const library = state.libraries[selectedLibraryId]
  const navStatus = ui.navStatus[selectedLibraryId]
  if (!library || !navStatus) return null

  if (library.type === 'comic' && navStatus.comicId) {
    return { type: library.type, id: navStatus.comicId }
  }
  if (library.type === 'book' && navStatus.bookId) {
    return { type: library.type, id: navStatus.bookId }
  }

  return null
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
    bookRefreshTokens: {},
    loadStatus: 'idle',

    hydrate: async () => {
      if (hydrateLoad) return hydrateLoad
      const wasReady = get().loadStatus === 'ready'
      const seq = ++hydrateSeq

      hydrateLoad = (async () => {
        set((state) => {
          if (!wasReady) {
            state.loadStatus = 'loading'
            delete state.loadError
          }
        })
        try {
          const catalog = await fetchRemoteCatalog({
            allowEmptyTagsFallback: !wasReady,
          })
          if (seq !== hydrateSeq) return
          latestTags = catalog.tags
          const maps = buildMaps(catalog, get(), wasReady)
          const orderedLibraryIds = applyLibraryOrder(
            maps.libraries,
            readStoredLibraryOrder(),
          )
          set((state) => {
            Object.assign(state, maps)
            state.loadStatus = 'ready'
          })

          const ui = useUIStore.getState()
          if (!ui.selectedLibraryId || !maps.libraries[ui.selectedLibraryId]) {
            ui.setSelectedLibraryId(orderedLibraryIds[0] ?? null)
          }
          pruneTabsForCatalog(maps.comics, maps.books)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.error('Failed to fetch manifest:', error)
          if (wasReady) return
          if (seq !== hydrateSeq) return
          set((state) => {
            state.loadStatus = 'failed'
            state.loadError = message
          })
        } finally {
          if (hydrateLoad) hydrateLoad = null
        }
      })()

      return hydrateLoad
    },

    refreshCurrentResource: async () => {
      await get().hydrate()
      const target = resolveCurrentResource(get())
      if (!target) return

      const state = get()
      if (target.type === 'comic') {
        if (!state.comics[target.id]) return
        await get().getComicImages(target.id, { force: true })
        return
      }

      if (!state.books[target.id]) return
      set((state) => {
        state.bookRefreshTokens[target.id] =
          (state.bookRefreshTokens[target.id] ?? 0) + 1
      })
    },

    reorderLibrary: (orderedIds) => {
      const nextOrder = normalizeLibraryOrder(get().libraries, orderedIds)
      set((state) => {
        applyLibraryOrder(state.libraries, nextOrder)
      })
      writeStoredLibraryOrder(nextOrder)
    },
    getBookChapters: async (bookId, { force = false }: ResourceLoadOptions = {}) => {
      const book = get().books[bookId]
      const source = get().bookSources[bookId]
      if (!book || !source) return []
      const status = get().bookChapterStatus[bookId] ?? 'idle'
      if (!force && status === 'ready') return book.chapters
      const existingLoad = bookChapterLoads.get(bookId)
      if (existingLoad) return existingLoad

      set((state) => {
        state.bookChapterStatus[bookId] = 'loading'
      })

      const load = (async () => {
        try {
          const chapters = await fetchRemoteBookChapters(source, {
            tags: latestTags ?? undefined,
          })
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
        } finally {
          bookChapterLoads.delete(bookId)
        }
      })()

      bookChapterLoads.set(bookId, load)
      return load
    },
    updateBookTags: async (bookId, tags) => {
      const previous = get().books[bookId]
      if (!previous) return
      const rollback = snapshotFileTags(previous)

      await commitTagUpdate({
        target: bookTagTarget(previous),
        tags,
        latestTags,
        apply: () =>
          set((state) => {
            const book = state.books[bookId]
            if (book) applyFileTags(book, tags)
          }),
        rollback: () =>
          set((state) => {
            const book = state.books[bookId]
            if (book) applyFileTags(book, rollback)
          }),
        errorMessage: `Failed to update book tags for ${bookId}:`,
      })
    },
    updateComicTags: async (comicId, tags) => {
      const previous = get().comics[comicId]
      if (!previous) return
      const rollback = snapshotFileTags(previous)

      await commitTagUpdate({
        target: comicTagTarget(previous),
        tags,
        latestTags,
        apply: () =>
          set((state) => {
            const comic = state.comics[comicId]
            if (comic) applyFileTags(comic, tags)
          }),
        rollback: () =>
          set((state) => {
            const comic = state.comics[comicId]
            if (comic) applyFileTags(comic, rollback)
          }),
        errorMessage: `Failed to update comic tags for ${comicId}:`,
      })
    },
    updateComicImageTags: async (comicId, imageKey, tags) => {
      const previous = get().comicImages[comicId]?.images.find(
        (image) => image.path === imageKey,
      )
      if (!previous) return
      const rollback = snapshotFileTags(previous)

      await commitTagUpdate({
        target: imageTagTarget(imageKey),
        tags,
        latestTags,
        apply: () =>
          set((state) => {
            const image = state.comicImages[comicId]?.images.find(
              (item) => item.path === imageKey,
            )
            if (image) applyFileTags(image, tags)
          }),
        rollback: () =>
          set((state) => {
            const image = state.comicImages[comicId]?.images.find(
              (item) => item.path === imageKey,
            )
            if (image) applyFileTags(image, rollback)
          }),
        errorMessage: `Failed to update image tags for ${imageKey}:`,
      })
    },
    updateBookChapterTags: async (bookId, lineIndex, tags) => {
      const book = get().books[bookId]
      const previous = book?.chapters.find(
        (chapter) => chapter.lineIndex === lineIndex,
      )
      if (!book || !previous) return
      const rollback = snapshotFileTags(previous)

      await commitTagUpdate({
        target: chapterTagTarget(book, previous),
        tags,
        latestTags,
        apply: () =>
          set((state) => {
            const chapter = state.books[bookId]?.chapters.find(
              (item) => item.lineIndex === lineIndex,
            )
            if (chapter) applyFileTags(chapter, tags)
          }),
        rollback: () =>
          set((state) => {
            const chapter = state.books[bookId]?.chapters.find(
              (item) => item.lineIndex === lineIndex,
            )
            if (chapter) applyFileTags(chapter, rollback)
          }),
        errorMessage: `Failed to update chapter tags for ${bookId}:${lineIndex}:`,
      })
    },

    getComicImages: async (comicId, { force = false }: ResourceLoadOptions = {}) => {
      const item = get().comicImages[comicId]
      const source = get().comicSources[comicId]
      if (!item || !source) return []
      if (!force && (item.status === 'ready' || item.status === 'empty')) {
        return item.images
      }
      const existingLoad = comicImageLoads.get(comicId)
      if (existingLoad) return existingLoad

      set((state) => {
        const current = state.comicImages[comicId]
        if (!current) return
        current.status = 'loading'
        delete current.error
      })

      const load = (async () => {
        try {
          const images = await fetchRemoteComicImages(source, {
            tags: latestTags ?? undefined,
          })
          set((state) => {
            const current = state.comicImages[comicId]
            if (!current) return
            current.status = images.length ? 'ready' : 'empty'
            current.images = images
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
          })
          return []
        } finally {
          comicImageLoads.delete(comicId)
        }
      })()

      comicImageLoads.set(comicId, load)
      return load
    },
  })),
)
