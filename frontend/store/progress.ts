import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import type { BookProgress, ComicProgress } from '@/types/library'

interface ProgressState {
  comics: Record<string, ComicProgress>
  books: Record<string, BookProgress>
  updateComicProgress: (comicId: string, progress: ComicProgress) => void
  updateBookProgress: (bookId: string, progress: BookProgress) => void
}

interface PersistedProgressState {
  comics: Record<string, ComicProgress>
  books: Record<string, BookProgress>
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
  return {
    ...current,
    comics: isProgressRecord(state.comics) as Record<string, ComicProgress>,
    books: isProgressRecord(state.books) as Record<string, BookProgress>,
  }
}

export const useProgressStore = create<ProgressState>()(
  persist(
    immer((set) => ({
      comics: {},
      books: {},
      updateComicProgress: (comicId, progress) =>
        set((state) => {
          state.comics[comicId] = progress
        }),
      updateBookProgress: (bookId, progress) =>
        set((state) => {
          state.books[bookId] = progress
        }),
    })),
    {
      name: 'megumi-progress',
      storage: createJSONStorage(() => localStorage),
      partialize: (state): PersistedProgressState => ({
        comics: state.comics,
        books: state.books,
      }),
      merge: mergePersistedProgress,
    },
  ),
)
