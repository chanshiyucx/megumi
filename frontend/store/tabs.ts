import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import {
  queueRemoteTabMutation,
  type RemoteTabs,
} from '@/lib/remote-tabs'
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

const LEGACY_TABS_STORAGE_KEY = 'megumi-tabs'

function syncRemoteTabs(
  mutation: Parameters<typeof queueRemoteTabMutation>[0],
) {
  void queueRemoteTabMutation(mutation).catch((error) => {
    console.error('Failed to sync tabs:', error)
  })
}

function readLegacyTabIds() {
  if (typeof window === 'undefined') return []

  try {
    const raw = localStorage.getItem(LEGACY_TABS_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return []
    const persisted = parsed as { state?: { tabs?: unknown } }
    if (!Array.isArray(persisted.state?.tabs)) return []

    const seen = new Set<string>()
    const tabIds: string[] = []
    for (const value of persisted.state.tabs) {
      if (!value || typeof value !== 'object') continue
      const id = (value as { id?: unknown }).id
      if (typeof id !== 'string' || !id || seen.has(id)) continue
      seen.add(id)
      tabIds.push(id)
    }
    return tabIds
  } catch (error) {
    console.error('Failed to read legacy tabs:', error)
    return []
  }
}

function clearLegacyTabs() {
  if (typeof window === 'undefined') return
  localStorage.removeItem(LEGACY_TABS_STORAGE_KEY)
}

export function hydrateTabsFromRemote(
  remoteTabs: RemoteTabs,
  resolveTab: (tabId: string) => Tab | undefined,
) {
  const legacyTabIds = remoteTabs.initialized ? [] : readLegacyTabIds()
  const sourceIds = legacyTabIds.length ? legacyTabIds : remoteTabs.tabIds
  const tabs: Tab[] = []
  const invalidRemoteIds: string[] = []

  for (const tabId of sourceIds) {
    const tab = resolveTab(tabId)
    if (tab) tabs.push(tab)
    else if (remoteTabs.initialized) invalidRemoteIds.push(tabId)
  }

  useTabsStore.setState((state) => ({
    tabs,
    activeTab: tabs.some((tab) => tab.id === state.activeTab)
      ? state.activeTab
      : '',
  }))

  if (legacyTabIds.length) {
    const tabIds = tabs.map((tab) => tab.id)
    if (!tabIds.length) {
      clearLegacyTabs()
      return
    }
    void queueRemoteTabMutation({ operation: 'initialize', tabIds })
      .then(clearLegacyTabs)
      .catch((error) => {
        console.error('Failed to migrate local tabs:', error)
      })
    return
  }

  if (remoteTabs.initialized) clearLegacyTabs()
  if (invalidRemoteIds.length) {
    syncRemoteTabs(
      invalidRemoteIds.map((tabId) => ({ operation: 'close', tabId })),
    )
  }
}

export const useTabsStore = create<TabsState>()(
  immer((set, get) => ({
    tabs: [],
    activeTab: '',
    addTab: (newTab) => {
      set((state) => {
        if (!state.tabs.some((tab) => tab.id === newTab.id)) {
          state.tabs.push(newTab)
        }
        state.activeTab = newTab.id
      })
      syncRemoteTabs({ operation: 'open', tabId: newTab.id })
    },
    removeTab: (tabId) => {
      const index = get().tabs.findIndex((tab) => tab.id === tabId)
      if (index === -1) return

      set((state) => {
        if (state.activeTab === tabId) {
          state.activeTab =
            state.tabs[index + 1]?.id ?? state.tabs[index - 1]?.id ?? ''
        }
        state.tabs.splice(index, 1)
      })
      syncRemoteTabs({ operation: 'close', tabId })
    },
    reorderTab: (tabId, overTabId) => {
      const oldIndex = get().tabs.findIndex((tab) => tab.id === tabId)
      const newIndex = get().tabs.findIndex((tab) => tab.id === overTabId)
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return

      set((state) => {
        const [tab] = state.tabs.splice(oldIndex, 1)
        state.tabs.splice(newIndex, 0, tab)
      })
      syncRemoteTabs({ operation: 'move', tabId, overTabId })
    },
    setActiveTab: (tabId) => set({ activeTab: tabId }),
  })),
)
