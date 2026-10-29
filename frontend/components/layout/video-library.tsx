import { useState } from 'react'
import { VirtuosoGrid } from 'react-virtuoso'
import { useShallow } from 'zustand/react/shallow'
import { COVER_GRID_CLASS, GridItem } from '@/components/ui/grid-item'
import { usePanelNav } from '@/hooks/use-panel-nav'
import { selectOrderedVideosForLibrary } from '@/lib/library-queries'
import { cn, LIST_COLUMN_CLASS } from '@/lib/style'
import { useLibraryStore } from '@/store/library'
import { useUIStore } from '@/store/ui'
import type { FileTags, Library, Video } from '@/types/library'
import { VideoPanel } from './video-panel'

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

export function VideoItem({ video, isSelected, onClick, onTags }: VideoItemProps) {
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
  const setNavStatus = useUIStore((state) => state.setNavStatus)
  const videoId = useUIStore(
    (state) => state.navStatus[selectedLibrary.id]?.videoId ?? '',
  )
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

  return (
    <div className="flex h-full w-full">
      <div
        className={cn(
          'min-h-0 flex-col border-r',
          LIST_COLUMN_CLASS,
          middleClass,
        )}
      >
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
          listClassName={COVER_GRID_CLASS}
          increaseViewportBy={600}
        />
      </div>

      <VideoPanel
        videoId={videoId}
        className={readerClass}
        readerVisible={readerVisible}
        playRequest={playRequest}
      />
    </div>
  )
}
