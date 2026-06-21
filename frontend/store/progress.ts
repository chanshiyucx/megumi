import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import type { BookProgress, ComicProgress } from '@/types/library'

interface ProgressState {
  comics: Record<string, ComicProgress>
  books: Record<string, BookProgress>
  favoriteChapters: Record<string, number[]>
  updateComicProgress: (comicId: string, progress: ComicProgress) => void
  updateBookProgress: (bookId: string, progress: BookProgress) => void
  removeComicProgress: (comicId: string) => void
  removeBookProgress: (bookId: string) => void
  toggleChapterFavorite: (bookId: string, lineIndex: number) => void
  removeBookChapters: (bookId: string) => void
}

interface PersistedProgressState {
  comics: Record<string, ComicProgress>
  books: Record<string, BookProgress>
  favoriteChapters: Record<string, number[]>
}

export const useProgressStore = create<ProgressState>()(
  persist(
    immer((set) => ({
      comics: {},
      books: {},
      favoriteChapters: {},
      updateComicProgress: (comicId, progress) =>
        set((state) => {
          state.comics[comicId] = progress
        }),
      updateBookProgress: (bookId, progress) =>
        set((state) => {
          state.books[bookId] = progress
        }),
      removeComicProgress: (comicId) =>
        set((state) => {
          delete state.comics[comicId]
        }),
      removeBookProgress: (bookId) =>
        set((state) => {
          delete state.books[bookId]
        }),
      toggleChapterFavorite: (bookId, lineIndex) =>
        set((state) => {
          const list = state.favoriteChapters[bookId]
          if (!list) {
            state.favoriteChapters[bookId] = [lineIndex]
            return
          }

          const index = list.indexOf(lineIndex)
          if (index === -1) {
            list.push(lineIndex)
            return
          }

          list.splice(index, 1)
          if (list.length === 0) delete state.favoriteChapters[bookId]
        }),
      removeBookChapters: (bookId) =>
        set((state) => {
          delete state.favoriteChapters[bookId]
        }),
    })),
    {
      name: 'megumi-progress',
      storage: createJSONStorage(() => localStorage),
      partialize: (state): PersistedProgressState => ({
        comics: state.comics,
        books: state.books,
        favoriteChapters: state.favoriteChapters,
      }),
    },
  ),
)
