import { Star, StepForward, Trash2 } from 'lucide-react'
import { useEffect, useEffectEvent } from 'react'
import { Button } from '@/components/ui/button'
import { SHORTCUTS } from '@/lib/shortcuts'
import { cn } from '@/lib/style'
import { useLibraryStore } from '@/store/library'
import { useTabsStore } from '@/store/tabs'
import { LibraryType } from '@/types/library'
import { VideoPlayer } from './video-player'

interface VideoPanelProps {
  videoId: string
  className?: string
  readerVisible: boolean
  // Bumped by the list on every selection so the player starts playing.
  playRequest: number
}

/**
 * The player side of a video surface: toolbar plus inline player. Shared by
 * the video library and the favorites view.
 */
export function VideoPanel({
  videoId,
  className,
  readerVisible,
  playRequest,
}: VideoPanelProps) {
  const activeTab = useTabsStore((state) => state.activeTab)
  const video = useLibraryStore((state) => state.videos[videoId])
  const updateVideoTags = useLibraryStore((state) => state.updateVideoTags)

  const openTab = () => {
    if (!video || activeTab === video.id) return
    useTabsStore.getState().addTab({
      type: LibraryType.video,
      id: video.id,
      title: video.title,
    })
  }

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey || activeTab || !video)
      return
    switch (event.code) {
      case SHORTCUTS.continueReading:
        openTab()
        break
      case SHORTCUTS.toggleItemDeleted:
        void updateVideoTags(video.id, { deleted: !video.deleted })
        break
      case SHORTCUTS.toggleItemStarred:
        void updateVideoTags(video.id, { starred: !video.starred })
        break
    }
  })

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
    <div className={cn('min-h-0 min-w-0 flex-1 flex-col', className)}>
      <div className="bg-base text-subtle grid h-8 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 border-b px-3 text-xs">
        <div className="flex gap-2">
          <Button className="h-6 w-6" onClick={openTab} title="在标签页中打开">
            <StepForward className="h-4 w-4" />
          </Button>
          {video && (
            <>
              <Button
                className="h-6 w-6"
                onClick={() =>
                  void updateVideoTags(video.id, { deleted: !video.deleted })
                }
                title="标记删除"
              >
                <Trash2
                  className={cn('h-4 w-4', video.deleted && 'text-subtle/40')}
                />
              </Button>
              <Button
                className="h-6 w-6"
                onClick={() =>
                  void updateVideoTags(video.id, { starred: !video.starred })
                }
                title="标记收藏"
              >
                <Star
                  className={cn(
                    'h-4 w-4',
                    video.starred && 'text-love fill-gold/80',
                  )}
                />
              </Button>
            </>
          )}
        </div>
        <h3 className="min-w-0 truncate" title={video?.title}>
          {video?.title}
        </h3>
      </div>
      {video && (
        <VideoPlayer
          key={video.id}
          videoId={video.id}
          active={!activeTab && readerVisible}
          playRequest={playRequest}
        />
      )}
    </div>
  )
}
