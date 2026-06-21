'use client'

import { useEffect, useEffectEvent } from 'react'
import { RefreshCw } from 'lucide-react'
import { AppLayout } from '@/components/layout/app-layout'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useLibraryStore } from '@/store/library'
import { initializeThemeSync } from '@/store/ui'

export function App() {
  const loadStatus = useLibraryStore((state) => state.loadStatus)
  const loadError = useLibraryStore((state) => state.loadError)
  const hydrate = useLibraryStore((state) => state.hydrate)
  const refreshHydrate = useEffectEvent(() => hydrate())

  useEffect(() => {
    const cleanupThemeSync = initializeThemeSync()
    let inflight: Promise<void> | null = null
    const refresh = () => {
      if (inflight) return inflight
      inflight = refreshHydrate().finally(() => {
        inflight = null
      })
      return inflight
    }
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }

    void refresh()
    window.addEventListener('focus', refreshWhenVisible)
    window.addEventListener('pageshow', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.removeEventListener('focus', refreshWhenVisible)
      window.removeEventListener('pageshow', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      cleanupThemeSync()
    }
  }, [])

  if (loadStatus === 'idle' || loadStatus === 'loading') {
    return (
      <div className="bg-surface flex h-dvh w-screen items-center justify-center">
        <Spinner size="large" />
      </div>
    )
  }

  if (loadStatus === 'failed') {
    return (
      <div className="bg-surface text-subtle flex h-dvh w-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="max-w-lg text-sm">{loadError}</p>
        <Button className="gap-2 px-3" onClick={() => void hydrate()}>
          <RefreshCw className="h-4 w-4" />
          重试
        </Button>
      </div>
    )
  }

  return <AppLayout />
}
