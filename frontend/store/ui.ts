import { create } from 'zustand'
import {
  createJSONStorage,
  persist,
  subscribeWithSelector,
} from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import type {
  ComicLibrarySortMode,
  FavoriteCategory,
  FavoritesNavStatus,
  LibraryNavStatus,
} from '@/types/library'

export type ThemeMode = 'light' | 'dark'
export type ComicLibraryViewMode = 'grid' | 'scroll'

interface UIState {
  isSidebarCollapsed: boolean
  isMiddleCollapsed: boolean
  isImmersive: boolean
  theme: ThemeMode
  comicLibraryViewMode: ComicLibraryViewMode
  comicLibrarySortMode: ComicLibrarySortMode
  selectedLibraryId: string | null
  navStatus: Record<string, LibraryNavStatus>
  favoritesNav: FavoritesNavStatus
  toggleSidebar: () => void
  toggleMiddle: () => void
  setSidebarCollapsed: (value: boolean) => void
  setMiddleCollapsed: (value: boolean) => void
  toggleImmersive: () => void
  setTheme: (theme: ThemeMode) => void
  setComicLibraryViewMode: (viewMode: ComicLibraryViewMode) => void
  setComicLibrarySortMode: (sortMode: ComicLibrarySortMode) => void
  setSelectedLibraryId: (id: string | null) => void
  setNavStatus: (libraryId: string, status: LibraryNavStatus) => void
  setFavoritesNav: (status: Partial<FavoritesNavStatus>) => void
}

interface PersistedUIState {
  isSidebarCollapsed: boolean
  isMiddleCollapsed: boolean
  isImmersive: boolean
  theme: ThemeMode
  comicLibraryViewMode: ComicLibraryViewMode
  comicLibrarySortMode: ComicLibrarySortMode
  selectedLibraryId: string | null
  navStatus: Record<string, LibraryNavStatus>
  favoritesNav: FavoritesNavStatus
}

const sanitizeThemeMode = (theme: unknown): ThemeMode =>
  theme === 'dark' ? 'dark' : 'light'

const sanitizeComicLibraryViewMode = (
  viewMode: unknown,
): ComicLibraryViewMode => (viewMode === 'scroll' ? 'scroll' : 'grid')

const sanitizeComicLibrarySortMode = (
  sortMode: unknown,
): ComicLibrarySortMode => {
  if (sortMode === 'created-desc' || sortMode === 'title') return sortMode
  return 'created-asc'
}

const FAVORITE_CATEGORIES: FavoriteCategory[] = [
  'comic',
  'image',
  'book',
  'chapter',
  'video',
]

const sanitizeFavoritesNav = (value: unknown): FavoritesNavStatus => {
  const status =
    value && typeof value === 'object'
      ? (value as Partial<FavoritesNavStatus>)
      : {}
  return {
    ...status,
    category: FAVORITE_CATEGORIES.includes(status.category as FavoriteCategory)
      ? (status.category as FavoriteCategory)
      : 'comic',
  }
}

const applyTheme = (theme: ThemeMode) => {
  if (typeof window === 'undefined') return
  document.documentElement.setAttribute('data-theme', sanitizeThemeMode(theme))
}

let cleanupThemeSync: (() => void) | null = null

export function initializeThemeSync() {
  if (typeof window === 'undefined') return () => {}
  if (cleanupThemeSync) return cleanupThemeSync

  const currentTheme = useUIStore.getState().theme
  const sanitizedTheme = sanitizeThemeMode(currentTheme)
  if (currentTheme !== sanitizedTheme) {
    useUIStore.setState({ theme: sanitizedTheme })
  } else {
    applyTheme(sanitizedTheme)
  }
  const unsubscribeTheme = useUIStore.subscribe((state) => state.theme, applyTheme)

  cleanupThemeSync = () => {
    unsubscribeTheme()
    cleanupThemeSync = null
  }

  return cleanupThemeSync
}

export const useUIStore = create<UIState>()(
  subscribeWithSelector(
    persist(
      immer((set) => ({
        isSidebarCollapsed: false,
        isMiddleCollapsed: false,
        isImmersive: false,
        theme: 'light',
        comicLibraryViewMode: 'grid',
        comicLibrarySortMode: 'created-asc',
        selectedLibraryId: null,
        navStatus: {},
        favoritesNav: { category: 'comic' },
        toggleSidebar: () =>
          set((state) => {
            state.isSidebarCollapsed = !state.isSidebarCollapsed
          }),
        toggleMiddle: () =>
          set((state) => {
            state.isMiddleCollapsed = !state.isMiddleCollapsed
          }),
        setSidebarCollapsed: (value) => set({ isSidebarCollapsed: value }),
        setMiddleCollapsed: (value) => set({ isMiddleCollapsed: value }),
        toggleImmersive: () =>
          set((state) => {
            state.isImmersive = !state.isImmersive
          }),
        setTheme: (theme) => set({ theme: sanitizeThemeMode(theme) }),
        setComicLibraryViewMode: (viewMode) =>
          set({
            comicLibraryViewMode: sanitizeComicLibraryViewMode(viewMode),
          }),
        setComicLibrarySortMode: (sortMode) =>
          set({
            comicLibrarySortMode: sanitizeComicLibrarySortMode(sortMode),
          }),
        setSelectedLibraryId: (id) => set({ selectedLibraryId: id }),
        setNavStatus: (libraryId, status) =>
          set((state) => {
            state.navStatus[libraryId] = {
              ...state.navStatus[libraryId],
              ...status,
            }
          }),
        setFavoritesNav: (status) =>
          set((state) => {
            state.favoritesNav = { ...state.favoritesNav, ...status }
          }),
      })),
      {
        name: 'megumi-ui',
        storage: createJSONStorage(() => localStorage),
        partialize: (state): PersistedUIState => ({
          isSidebarCollapsed: state.isSidebarCollapsed,
          isMiddleCollapsed: state.isMiddleCollapsed,
          isImmersive: state.isImmersive,
          theme: state.theme,
          comicLibraryViewMode: state.comicLibraryViewMode,
          comicLibrarySortMode: state.comicLibrarySortMode,
          selectedLibraryId: state.selectedLibraryId,
          navStatus: state.navStatus,
          favoritesNav: state.favoritesNav,
        }),
        merge: (persisted, current) => {
          const state = (persisted ?? {}) as Partial<PersistedUIState>
          return {
            ...current,
            ...state,
            favoritesNav: sanitizeFavoritesNav(state.favoritesNav),
          }
        },
      },
    ),
  ),
)
