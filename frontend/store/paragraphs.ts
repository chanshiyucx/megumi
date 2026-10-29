import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import {
  fetchRemoteParagraphs,
  queueRemoteParagraphMutations,
  type ParagraphFavorite,
  type RemoteParagraphMutation,
} from '@/lib/remote-paragraphs'

type LoadStatus = 'idle' | 'loading' | 'ready' | 'failed'

interface ParagraphsState {
  paragraphs: Record<string, ParagraphFavorite>
  status: LoadStatus
  // Favorites a reader could not find in the current text of their book
  // (device-local; refreshed whenever a reader matches that book).
  missing: Record<string, true>
  ensureLoaded: () => Promise<void>
  refresh: () => Promise<void>
  addParagraphs: (entries: ParagraphFavorite[]) => Promise<void>
  removeParagraphs: (ids: string[]) => Promise<void>
  updateParagraphs: (entries: ParagraphFavorite[]) => Promise<void>
  setMissing: (changes: Record<string, boolean>) => void
}

let refreshLoad: Promise<void> | null = null
// Bumped by every local write; a refresh that started before one is dropped so
// its older snapshot cannot undo an optimistic change.
let localWriteSeq = 0

export const useParagraphsStore = create<ParagraphsState>()(
  immer((set, get) => {
    const commit = async (
      mutations: RemoteParagraphMutation[],
      apply: (state: ParagraphsState) => void,
      rollback: (state: ParagraphsState) => void,
      errorMessage: string,
    ) => {
      if (!mutations.length) return
      localWriteSeq += 1
      set(apply)
      try {
        await queueRemoteParagraphMutations(mutations)
      } catch (error) {
        console.error(errorMessage, error)
        set(rollback)
      }
    }

    return {
      paragraphs: {},
      status: 'idle',
      missing: {},

      ensureLoaded: async () => {
        if (get().status === 'idle' || get().status === 'failed') {
          await get().refresh()
        }
      },

      refresh: async () => {
        if (refreshLoad) return refreshLoad
        const seq = localWriteSeq
        refreshLoad = (async () => {
          if (get().status !== 'ready') set({ status: 'loading' })
          try {
            const paragraphs = await fetchRemoteParagraphs()
            if (seq !== localWriteSeq) return
            set({ paragraphs, status: 'ready' })
          } catch (error) {
            console.error('Failed to fetch paragraphs:', error)
            if (get().status !== 'ready') set({ status: 'failed' })
          } finally {
            refreshLoad = null
          }
        })()
        return refreshLoad
      },

      addParagraphs: (entries) =>
        commit(
          entries.map((paragraph) => ({ operation: 'add', paragraph })),
          (state) => {
            for (const entry of entries) state.paragraphs[entry.id] = entry
          },
          (state) => {
            for (const entry of entries) delete state.paragraphs[entry.id]
          },
          'Failed to add paragraphs:',
        ),

      removeParagraphs: (ids) => {
        const removed = ids
          .map((id) => get().paragraphs[id])
          .filter((entry): entry is ParagraphFavorite => Boolean(entry))
        return commit(
          removed.map(({ id }) => ({ operation: 'remove', id })),
          (state) => {
            for (const { id } of removed) delete state.paragraphs[id]
          },
          (state) => {
            for (const entry of removed) state.paragraphs[entry.id] = entry
          },
          'Failed to remove paragraphs:',
        )
      },

      updateParagraphs: (entries) => {
        const previous = entries
          .map(({ id }) => get().paragraphs[id])
          .filter((entry): entry is ParagraphFavorite => Boolean(entry))
        return commit(
          previous.map(({ id }) => ({
            operation: 'update',
            paragraph: entries.find((entry) => entry.id === id)!,
          })),
          (state) => {
            for (const { id } of previous) {
              state.paragraphs[id] = entries.find((entry) => entry.id === id)!
            }
          },
          (state) => {
            for (const entry of previous) state.paragraphs[entry.id] = entry
          },
          'Failed to update paragraphs:',
        )
      },

      setMissing: (changes) => {
        const missing = get().missing
        const differs = Object.entries(changes).some(
          ([id, isMissing]) => Boolean(missing[id]) !== isMissing,
        )
        if (!differs) return
        set((state) => {
          for (const [id, isMissing] of Object.entries(changes)) {
            if (isMissing) state.missing[id] = true
            else delete state.missing[id]
          }
        })
      },
    }
  }),
)
