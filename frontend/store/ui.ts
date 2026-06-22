import { create } from 'zustand'
import {
  createJSONStorage,
  persist,
  subscribeWithSelector,
} from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import type { LibraryNavStatus } from '@/types/library'

export type ThemeMode = 'light' | 'dark'
export type ComicLibraryViewMode = 'grid' | 'scroll'

interface UIState {
  isSidebarCollapsed: boolean
  isMiddleCollapsed: boolean
  isImmersive: boolean
  theme: ThemeMode
  comicLibraryViewMode: ComicLibraryViewMode
  selectedLibraryId: string | null
  navStatus: Record<string, LibraryNavStatus>
  toggleSidebar: () => void
  toggleMiddle: () => void
  setSidebarCollapsed: (value: boolean) => void
  setMiddleCollapsed: (value: boolean) => void
  toggleImmersive: () => void
  setTheme: (theme: ThemeMode) => void
  setComicLibraryViewMode: (viewMode: ComicLibraryViewMode) => void
  setSelectedLibraryId: (id: string | null) => void
  setNavStatus: (libraryId: string, status: LibraryNavStatus) => void
}

interface PersistedUIState {
  isSidebarCollapsed: boolean
  isMiddleCollapsed: boolean
  isImmersive: boolean
  theme: ThemeMode
  comicLibraryViewMode: ComicLibraryViewMode
  selectedLibraryId: string | null
  navStatus: Record<string, LibraryNavStatus>
}

const sanitizeThemeMode = (theme: unknown): ThemeMode =>
  theme === 'dark' ? 'dark' : 'light'

const sanitizeComicLibraryViewMode = (
  viewMode: unknown,
): ComicLibraryViewMode => (viewMode === 'scroll' ? 'scroll' : 'grid')

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
        selectedLibraryId: null,
        navStatus: {},
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
        setSelectedLibraryId: (id) => set({ selectedLibraryId: id }),
        setNavStatus: (libraryId, status) =>
          set((state) => {
            state.navStatus[libraryId] = {
              ...state.navStatus[libraryId],
              ...status,
            }
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
          selectedLibraryId: state.selectedLibraryId,
          navStatus: state.navStatus,
        }),
      },
    ),
  ),
)
