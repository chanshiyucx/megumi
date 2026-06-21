import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import type { LibraryNavStatus } from '@/types/library'

export type ThemeMode = 'light' | 'dark' | 'system'

interface UIState {
  isSidebarCollapsed: boolean
  isMiddleCollapsed: boolean
  isImmersive: boolean
  theme: ThemeMode
  selectedLibraryId: string | null
  navStatus: Record<string, LibraryNavStatus>
  toggleSidebar: () => void
  toggleMiddle: () => void
  setSidebarCollapsed: (value: boolean) => void
  setMiddleCollapsed: (value: boolean) => void
  toggleImmersive: () => void
  setTheme: (theme: ThemeMode) => void
  setSelectedLibraryId: (id: string | null) => void
  setNavStatus: (libraryId: string, status: LibraryNavStatus) => void
}

const applyTheme = (theme: ThemeMode) => {
  if (typeof window === 'undefined') return
  const resolved =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme
  document.documentElement.setAttribute('data-theme', resolved)
}

let cleanupThemeSync: (() => void) | null = null

export function initializeThemeSync() {
  if (typeof window === 'undefined') return () => {}
  if (cleanupThemeSync) return cleanupThemeSync

  applyTheme(useUIStore.getState().theme)
  const unsubscribeTheme = useUIStore.subscribe((state) => state.theme, applyTheme)
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  const handleSystemThemeChange = () => {
    if (useUIStore.getState().theme === 'system') applyTheme('system')
  }
  mediaQuery.addEventListener('change', handleSystemThemeChange)

  cleanupThemeSync = () => {
    unsubscribeTheme()
    mediaQuery.removeEventListener('change', handleSystemThemeChange)
    cleanupThemeSync = null
  }

  return cleanupThemeSync
}

export const useUIStore = create<UIState>()(
  subscribeWithSelector(
    immer((set) => ({
      isSidebarCollapsed: false,
      isMiddleCollapsed: false,
      isImmersive: false,
      theme: 'system',
      selectedLibraryId: null,
      navStatus: {},
      toggleSidebar: () => set((state) => { state.isSidebarCollapsed = !state.isSidebarCollapsed }),
      toggleMiddle: () => set((state) => { state.isMiddleCollapsed = !state.isMiddleCollapsed }),
      setSidebarCollapsed: (value) => set({ isSidebarCollapsed: value }),
      setMiddleCollapsed: (value) => set({ isMiddleCollapsed: value }),
      toggleImmersive: () => set((state) => { state.isImmersive = !state.isImmersive }),
      setTheme: (theme) => set({ theme }),
      setSelectedLibraryId: (id) => set({ selectedLibraryId: id }),
      setNavStatus: (libraryId, status) =>
        set((state) => {
          state.navStatus[libraryId] = { ...state.navStatus[libraryId], ...status }
        }),
    })),
  ),
)
