import { useState } from 'react'
import { BookReader } from '@/components/layout/book-reader'
import { ComicReader } from '@/components/layout/comic-reader'
import { VideoPlayer } from '@/components/layout/video-player'
import { cn } from '@/lib/style'
import { useTabsStore, type Tab } from '@/store/tabs'
import { useUIStore } from '@/store/ui'
import { LibraryType } from '@/types/library'

// The front tab plus this many recently used ones stay mounted, so switching
// back to them is instant; older ones are unmounted to free their images and
// text (on iPad a page holding many readers gets reloaded by the system) and
// reopen at their saved position.
const KEPT_BACKGROUND_TABS = 2

interface TabContentProps {
  tab: Tab
  isActive: boolean
  isImmersive: boolean
}

function TabContent({ tab, isActive, isImmersive }: TabContentProps) {
  const { type, id } = tab

  return (
    <div
      className={cn(
        'bg-surface fixed inset-0 z-100',
        // Not display: none, which drops the layout and makes a whole book
        // lay out again on every switch back; content-visibility skips the
        // rendering but keeps the layout (and scroll offsets) for the return.
        !isActive && 'pointer-events-none invisible [content-visibility:hidden]',
        isImmersive ? 'top-0' : 'top-8',
      )}
    >
      {type === LibraryType.book ? (
        <BookReader bookId={id} surface="tab" />
      ) : type === LibraryType.comic ? (
        <ComicReader comicId={id} />
      ) : (
        <VideoPlayer videoId={id} active={isActive} />
      )}
    </div>
  )
}

export function TabArea() {
  const tabs = useTabsStore((s) => s.tabs)
  const activeTab = useTabsStore((s) => s.activeTab)
  const isImmersive = useUIStore((s) => s.isImmersive)
  // Tab ids, most recently in front first.
  const [recentTabs, setRecentTabs] = useState<string[]>([])

  if (activeTab && recentTabs[0] !== activeTab) {
    setRecentTabs([
      activeTab,
      ...recentTabs
        .filter((id) => id !== activeTab)
        .slice(0, KEPT_BACKGROUND_TABS),
    ])
  }

  return (
    <>
      {tabs
        .filter(
          (tab) =>
            tab.id === activeTab ||
            // A video stops and rewinds when it leaves the front anyway.
            (tab.type !== LibraryType.video && recentTabs.includes(tab.id)),
        )
        .map((tab) => (
          <TabContent
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTab}
            isImmersive={isImmersive}
          />
        ))}
    </>
  )
}
