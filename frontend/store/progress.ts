import { create } from 'zustand'
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

export const useProgressStore = create<ProgressState>()(
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
    toggleChapterFavorite: () => {},
    removeBookChapters: (bookId) =>
      set((state) => {
        delete state.favoriteChapters[bookId]
      }),
  })),
)
