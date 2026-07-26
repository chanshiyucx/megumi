import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import type { LibraryType } from '@/types/library'

export interface Tab {
  type: LibraryType
  id: string
  title: string
}

interface TabsState {
  tabs: Tab[]
  activeTab: string
  addTab: (tab: Tab) => void
  removeTab: (tabId: string) => void
  reorderTab: (tabId: string, overTabId: string) => void
  setActiveTab: (tabId: string) => void
}

interface PersistedTabsState {
  tabs: Tab[]
  activeTab: string
}

export const useTabsStore = create<TabsState>()(
  persist(
    immer((set) => ({
      tabs: [],
      activeTab: '',
      addTab: (newTab) =>
        set((state) => {
          if (!state.tabs.some((tab) => tab.id === newTab.id)) {
            state.tabs.push(newTab)
          }
          state.activeTab = newTab.id
        }),
      removeTab: (tabId) =>
        set((state) => {
          const index = state.tabs.findIndex((tab) => tab.id === tabId)
          if (index === -1) return
          if (state.activeTab === tabId) {
            state.activeTab =
              state.tabs[index + 1]?.id ?? state.tabs[index - 1]?.id ?? ''
          }
          state.tabs.splice(index, 1)
        }),
      reorderTab: (tabId, overTabId) =>
        set((state) => {
          const oldIndex = state.tabs.findIndex((tab) => tab.id === tabId)
          const newIndex = state.tabs.findIndex((tab) => tab.id === overTabId)
          if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return

          const [tab] = state.tabs.splice(oldIndex, 1)
          state.tabs.splice(newIndex, 0, tab)
        }),
      setActiveTab: (tabId) => set({ activeTab: tabId }),
    })),
    {
      name: 'megumi-tabs',
      storage: createJSONStorage(() => localStorage),
      partialize: (state): PersistedTabsState => ({
        tabs: state.tabs,
        activeTab: state.activeTab,
      }),
    },
  ),
)
