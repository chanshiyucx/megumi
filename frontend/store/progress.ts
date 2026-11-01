import { create } from 'zustand'
import {
  persist,
  type PersistStorage,
  type StorageValue,
} from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import {
  emptyProgressSnapshot,
  fetchRemoteProgress,
  isProgressSyncEnabled,
  PROGRESS_COLLECTIONS,
  pushRemoteProgress,
  type ProgressCollection,
  type ProgressSnapshot,
} from '@/lib/remote-progress'
import type { BookProgress, ComicProgress } from '@/types/library'

export type { ProgressCollection } from '@/lib/remote-progress'

interface ProgressState {
  comics: Record<string, ComicProgress>
  books: Record<string, BookProgress>
  // Newer positions from another device for a comic / book on screen here.
  // The reader offers to jump there instead of moving under the reader.
  remote: ProgressSnapshot
  updateComicProgress: (comicId: string, progress: ComicProgress) => void
  updateBookProgress: (bookId: string, progress: BookProgress) => void
  refresh: () => Promise<void>
  // Takes the other device's position, its lastRead included, as the local
  // one; the reader then moves there itself.
  acceptRemote: (collection: ProgressCollection, id: string) => void
  // Keeps reading here: forgets the other position and marks the local one as
  // the latest so it wins on every device.
  dismissRemote: (collection: ProgressCollection, id: string) => void
}

interface PersistedProgressState {
  comics: Record<string, ComicProgress>
  books: Record<string, BookProgress>
}

// Readers write every position as it changes (each line scrolled past); the
// whole map goes to localStorage at most this often, and the Worker gets a
// batch: the first change waits PUSH_DELAY_MS for more to join it.
const PERSIST_DELAY_MS = 1000
const PUSH_DELAY_MS = 5000
const PUSH_CHUNK_ENTRIES = 1000
// keepalive requests share a 64 KB body budget per page; one request with
// headroom goes out.
const KEEPALIVE_CHUNK_BYTES = 60 * 1024

const utf8 = new TextEncoder()

const dirty: Record<ProgressCollection, Set<string>> = {
  comics: new Set(),
  books: new Set(),
}
const viewing = new Map<string, number>()
let pushTimer: ReturnType<typeof setTimeout> | null = null
let refreshLoad: Promise<void> | null = null

function progressKey(collection: ProgressCollection, id: string) {
  return `${collection}:${id}`
}

/**
 * Marks a comic / book as on screen until the returned cleanup runs. A newer
 * position from another device then waits in `remote` for the reader to offer
 * it; items not on screen take it directly.
 */
export function watchProgress(collection: ProgressCollection, id: string) {
  const key = progressKey(collection, id)
  viewing.set(key, (viewing.get(key) ?? 0) + 1)
  return () => {
    const count = (viewing.get(key) ?? 1) - 1
    if (count > 0) {
      viewing.set(key, count)
      return
    }
    viewing.delete(key)
    settleOffered(collection, id)
  }
}

// Once nothing shows the comic / book, an offer left unanswered is settled the
// way an item off screen would have been: the other device's position is taken
// unless this device read on after it arrived.
function settleOffered(collection: ProgressCollection, id: string) {
  const state = useProgressStore.getState()
  const offered = state.remote[collection][id]
  if (!offered) return
  const local = state[collection][id]
  const apply = !local || offered.lastRead > local.lastRead
  useProgressStore.setState((draft) => {
    delete draft.remote[collection][id]
    if (apply) draft[collection][id] = offered
  })
}

/**
 * localStorage behind a delay: the latest state waits in memory and is written
 * once PERSIST_DELAY_MS after the first change, or right away when the page is
 * hidden or closed.
 */
function createDeferredStorage<S>(): PersistStorage<S> | undefined {
  if (typeof window === 'undefined') return undefined

  const pending = new Map<string, StorageValue<S>>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    for (const [name, value] of pending) {
      try {
        localStorage.setItem(name, JSON.stringify(value))
      } catch (error) {
        console.error('Failed to save progress:', error)
      }
    }
    pending.clear()
  }
  window.addEventListener('pagehide', flush)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })

  return {
    getItem: (name) => {
      const value = pending.get(name)
      if (value) return value
      const stored = localStorage.getItem(name)
      return stored ? (JSON.parse(stored) as StorageValue<S>) : null
    },
    setItem: (name, value) => {
      pending.set(name, value)
      timer ??= setTimeout(flush, PERSIST_DELAY_MS)
    },
    removeItem: (name) => {
      pending.delete(name)
      localStorage.removeItem(name)
    },
  }
}

function isProgressRecord(value: unknown) {
  return value && typeof value === 'object' ? value : {}
}

function mergePersistedProgress(
  persisted: unknown,
  current: ProgressState,
): ProgressState {
  if (!persisted || typeof persisted !== 'object') return current

  const state = persisted as Partial<PersistedProgressState>
  const books = isProgressRecord(state.books) as Record<string, BookProgress>
  // Older saves wrote '' before the first chapter, which the Worker refuses
  // and every push would then retry.
  for (const entry of Object.values(books)) {
    if (entry?.currentChapterTitle === '') delete entry.currentChapterTitle
  }
  return {
    ...current,
    comics: isProgressRecord(state.comics) as Record<string, ComicProgress>,
    books,
  }
}

// Opening or restoring a reader re-saves the position it already has; such a
// write must not refresh lastRead, or a device that was merely opened would
// count as the latest reader and override where another device got to.
function samePosition(a: BookProgress | undefined, b: BookProgress) {
  return (
    a?.current === b.current &&
    a.total === b.total &&
    a.currentChapterTitle === b.currentChapterTitle
  )
}

// lastRead only moves forward per entry: an entry that came from a device
// whose clock runs ahead, or was stamped past it on "stay here", must not be
// followed by an older-looking local write the Worker would refuse.
function withNextLastRead<T extends BookProgress>(
  previous: BookProgress | undefined,
  progress: T,
): T {
  return previous && progress.lastRead <= previous.lastRead
    ? { ...progress, lastRead: previous.lastRead + 1 }
    : progress
}

function markDirty(collection: ProgressCollection, id: string) {
  if (!isProgressSyncEnabled()) return
  dirty[collection].add(id)
  if (pushTimer === null) {
    pushTimer = setTimeout(() => {
      void pushProgress()
    }, PUSH_DELAY_MS)
  }
}

// Splits a patch by entry count and by its JSON size in UTF-8 bytes (ids are
// paths and chapter titles, mostly CJK at 3 bytes a character).
function chunkSnapshot(
  snapshot: ProgressSnapshot,
  maxEntries: number,
  maxBytes: number,
) {
  // {"comics":{},"books":{}}
  const baseBytes = 24
  const chunks: ProgressSnapshot[] = []
  let chunk = emptyProgressSnapshot()
  let count = 0
  let bytes = baseBytes
  for (const collection of PROGRESS_COLLECTIONS) {
    for (const [id, entry] of Object.entries(snapshot[collection])) {
      // "id":{...},
      const entryBytes =
        utf8.encode(JSON.stringify(id)).length +
        utf8.encode(JSON.stringify(entry)).length +
        2
      if (count && (count === maxEntries || bytes + entryBytes > maxBytes)) {
        chunks.push(chunk)
        chunk = emptyProgressSnapshot()
        count = 0
        bytes = baseBytes
      }
      chunk[collection][id] = entry
      count += 1
      bytes += entryBytes
    }
  }
  if (count) chunks.push(chunk)
  return chunks
}

function markChunksDirty(chunks: ProgressSnapshot[]) {
  for (const chunk of chunks) {
    for (const collection of PROGRESS_COLLECTIONS) {
      for (const id of Object.keys(chunk[collection])) dirty[collection].add(id)
    }
  }
}

/**
 * Takes in positions held by the Worker: an entry newer than the local one
 * replaces it, unless that comic / book is on screen at another position, in
 * which case it waits in `remote` for the reader.
 */
function mergeRemote(snapshot: ProgressSnapshot) {
  const state = useProgressStore.getState()
  const applied: [ProgressCollection, string, BookProgress][] = []
  const offered: [ProgressCollection, string, BookProgress][] = []
  for (const collection of PROGRESS_COLLECTIONS) {
    for (const [id, entry] of Object.entries(snapshot[collection])) {
      const local = state[collection][id]
      if (local && local.lastRead >= entry.lastRead) continue
      const pending = state.remote[collection][id]
      if (pending && pending.lastRead >= entry.lastRead) continue
      if (
        local?.current !== entry.current &&
        viewing.has(progressKey(collection, id))
      ) {
        offered.push([collection, id, entry])
      } else {
        applied.push([collection, id, entry])
      }
    }
  }
  if (!applied.length && !offered.length) return

  useProgressStore.setState((draft) => {
    for (const [collection, id, entry] of applied) {
      draft[collection][id] = entry
      delete draft.remote[collection][id]
    }
    for (const [collection, id, entry] of offered) {
      draft.remote[collection][id] = entry
    }
  })
}

/**
 * Sends the changed entries; the ones that fail are sent again later.
 *
 * A page being hidden or closed sends one keepalive request. What does not
 * fit in it, or a push the closing page cancels, is not lost: the next
 * refresh sends every local entry newer than the Worker's.
 */
export async function pushProgress({
  keepalive = false,
}: { keepalive?: boolean } = {}) {
  if (pushTimer !== null) {
    clearTimeout(pushTimer)
    pushTimer = null
  }
  const state = useProgressStore.getState()
  const patch = emptyProgressSnapshot()
  for (const collection of PROGRESS_COLLECTIONS) {
    for (const id of dirty[collection]) {
      const entry = state[collection][id]
      if (entry) patch[collection][id] = entry
    }
    dirty[collection].clear()
  }

  let chunks = chunkSnapshot(
    patch,
    PUSH_CHUNK_ENTRIES,
    keepalive ? KEEPALIVE_CHUNK_BYTES : Infinity,
  )
  if (keepalive) chunks = chunks.slice(0, 1)
  for (const [index, chunk] of chunks.entries()) {
    try {
      mergeRemote(await pushRemoteProgress(chunk, { keepalive }))
    } catch (error) {
      console.error('Failed to sync progress:', error)
      markChunksDirty(chunks.slice(index))
      return
    }
  }
}

/**
 * Pulls other devices' positions now and whenever the page comes back into
 * view, and sends pending ones when it is hidden or closed, where a batched
 * write would otherwise be lost. Returns the cleanup.
 *
 * Unlike the library refresh this is not rate-limited: a GET that has not
 * changed is a 304, and picking a book back up right after reading it on
 * another device is the case that matters.
 */
export function initializeProgressSync() {
  const refresh = () => {
    void useProgressStore.getState().refresh()
  }
  const pushNow = () => {
    void pushProgress({ keepalive: true })
  }
  const syncOnVisibility = () => {
    if (document.visibilityState === 'hidden') pushNow()
    else refresh()
  }

  refresh()
  document.addEventListener('visibilitychange', syncOnVisibility)
  window.addEventListener('focus', refresh)
  window.addEventListener('pageshow', refresh)
  window.addEventListener('pagehide', pushNow)
  return () => {
    document.removeEventListener('visibilitychange', syncOnVisibility)
    window.removeEventListener('focus', refresh)
    window.removeEventListener('pageshow', refresh)
    window.removeEventListener('pagehide', pushNow)
  }
}

export const useProgressStore = create<ProgressState>()(
  persist(
    immer((set, get) => ({
      comics: {},
      books: {},
      remote: emptyProgressSnapshot(),
      updateComicProgress: (comicId, progress) => {
        const previous = get().comics[comicId]
        if (samePosition(previous, progress)) return
        set((state) => {
          state.comics[comicId] = withNextLastRead(previous, progress)
        })
        markDirty('comics', comicId)
      },
      updateBookProgress: (bookId, progress) => {
        const previous = get().books[bookId]
        if (samePosition(previous, progress)) return
        set((state) => {
          state.books[bookId] = withNextLastRead(previous, progress)
        })
        markDirty('books', bookId)
      },

      refresh: async () => {
        if (!isProgressSyncEnabled()) return
        if (refreshLoad) return refreshLoad
        refreshLoad = (async () => {
          try {
            const snapshot = await fetchRemoteProgress()
            mergeRemote(snapshot)
            // Local entries the Worker lacks or holds older (positions read
            // offline, or from before sync existed) go up.
            const state = get()
            for (const collection of PROGRESS_COLLECTIONS) {
              for (const [id, entry] of Object.entries(state[collection])) {
                const stored = snapshot[collection][id]
                if (!stored || stored.lastRead < entry.lastRead) {
                  markDirty(collection, id)
                }
              }
            }
          } catch (error) {
            console.error('Failed to fetch progress:', error)
          } finally {
            refreshLoad = null
          }
        })()
        return refreshLoad
      },

      acceptRemote: (collection, id) => {
        const accepted = get().remote[collection][id]
        if (!accepted) return
        // Its lastRead becomes the floor for the writes that follow, which
        // stay ahead of it even when that device's clock runs ahead.
        set((state) => {
          delete state.remote[collection][id]
          state[collection][id] = accepted
        })
      },

      dismissRemote: (collection, id) => {
        const dismissed = get().remote[collection][id]
        if (!dismissed) return
        set((state) => {
          delete state.remote[collection][id]
          const local = state[collection][id]
          // Newer than the dismissed position even if that device's clock
          // runs ahead of this one's.
          if (local) {
            local.lastRead = Math.max(Date.now(), dismissed.lastRead + 1)
          }
        })
        if (get()[collection][id]) markDirty(collection, id)
      },
    })),
    {
      name: 'megumi-progress',
      storage: createDeferredStorage<PersistedProgressState>(),
      partialize: (state): PersistedProgressState => ({
        comics: state.comics,
        books: state.books,
      }),
      merge: mergePersistedProgress,
    },
  ),
)
