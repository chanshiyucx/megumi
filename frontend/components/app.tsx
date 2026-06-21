'use client'

import { useEffect } from 'react'
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

  useEffect(() => {
    const cleanupThemeSync = initializeThemeSync()
    void hydrate()

    return () => {
      cleanupThemeSync()
    }
  }, [hydrate])

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
