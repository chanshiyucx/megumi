import { Star, StepForward, Trash2 } from 'lucide-react'
import { useEffect, useEffectEvent, useState } from 'react'
import { VirtuosoGrid } from 'react-virtuoso'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import { GridItem } from '@/components/ui/grid-item'
import { usePanelNav } from '@/hooks/use-panel-nav'
import { selectOrderedVideosForLibrary } from '@/lib/library-queries'
import { SHORTCUTS } from '@/lib/shortcuts'
import { cn } from '@/lib/style'
import { useLibraryStore } from '@/store/library'
import { useTabsStore } from '@/store/tabs'
import { useUIStore } from '@/store/ui'
import { LibraryType, type FileTags, type Library, type Video } from '@/types/library'
import { VideoPlayer } from './video-player'

function formatDuration(durationMs: number) {
  const seconds = Math.max(0, Math.round(durationMs / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`
}

interface VideoItemProps {
  video: Video
  isSelected: boolean
  onClick: (id: string) => void
  onTags: (id: string, tags: FileTags) => Promise<void>
}

function VideoItem({ video, isSelected, onClick, onTags }: VideoItemProps) {
  return (
    <GridItem
      title={video.title}
      cover={video.cover}
      duration={formatDuration(video.durationMs)}
      starred={video.starred}
      deleted={video.deleted}
      isSelected={isSelected}
      onClick={() => onClick(video.id)}
      onStar={() => void onTags(video.id, { starred: !video.starred })}
      onDelete={() => void onTags(video.id, { deleted: !video.deleted })}
    />
  )
}

interface VideoLibraryProps {
  selectedLibrary: Library
}

export function VideoLibrary({ selectedLibrary }: VideoLibraryProps) {
  const { readerVisible, middleClass, readerClass, openReader } = usePanelNav()
  const [playRequest, setPlayRequest] = useState(0)
  const activeTab = useTabsStore((state) => state.activeTab)
  const setNavStatus = useUIStore((state) => state.setNavStatus)
  const videoId = useUIStore(
    (state) => state.navStatus[selectedLibrary.id]?.videoId ?? '',
  )
  const video = useLibraryStore((state) => state.videos[videoId])
  const videos = useLibraryStore(
    useShallow((state) =>
      selectOrderedVideosForLibrary(state, selectedLibrary.id),
    ),
  )
  const updateVideoTags = useLibraryStore((state) => state.updateVideoTags)

  const selectVideo = (id: string) => {
    if (id !== videoId) setNavStatus(selectedLibrary.id, { videoId: id })
    setPlayRequest((request) => request + 1)
    openReader()
  }

  const openTab = () => {
    if (!video || activeTab === video.id) return
    useTabsStore.getState().addTab({
      type: LibraryType.video,
      id: video.id,
      title: video.title,
    })
  }

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey || activeTab || !video) return
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
    <div className="flex h-full w-full">
      <div className={cn('min-h-0 flex-1 flex-col border-r', middleClass)}>
        <div className="bg-base text-subtle flex h-8 items-center justify-end border-b px-3 text-xs">
          <span>VIDEOS ({videos.length})</span>
        </div>
        <VirtuosoGrid
          aria-label="视频列表"
          className="flex-1"
          data={videos}
          itemContent={(_index, item) => (
            <VideoItem
              video={item}
              isSelected={videoId === item.id}
              onClick={selectVideo}
              onTags={updateVideoTags}
            />
          )}
          listClassName="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))]"
          increaseViewportBy={600}
        />
      </div>

      <div className={cn('min-h-0 min-w-0 flex-1 flex-col', readerClass)}>
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
                  <Trash2 className={cn('h-4 w-4', video.deleted && 'text-subtle/40')} />
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
    </div>
  )
}
