import { Expand, Pause, Play } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useLibraryStore } from '@/store/library'

interface VideoPlayerProps {
  videoId: string
  active: boolean
  playRequest?: number
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const rounded = Math.floor(seconds)
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  const remainder = rounded % 60
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`
}

export function VideoPlayer({
  videoId,
  active,
  playRequest = 0,
}: VideoPlayerProps) {
  const video = useLibraryStore((state) => state.videos[videoId])
  const containerRef = useRef<HTMLDivElement>(null)
  const mediaRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState((video?.durationMs ?? 0) / 1000)

  useEffect(() => {
    const media = mediaRef.current
    if (!media || active) return
    media.pause()
    media.currentTime = 0
    setCurrentTime(0)
  }, [active])

  useEffect(() => {
    const media = mediaRef.current
    if (!media || !active || playRequest === 0) return
    media.currentTime = 0
    setCurrentTime(0)
    void media.play().catch(() => {})
  }, [active, playRequest, videoId])

  if (!video) return null

  const togglePlayback = () => {
    const media = mediaRef.current
    if (!media) return
    if (media.paused) void media.play().catch(() => {})
    else media.pause()
  }

  const seek = (seconds: number) => {
    const media = mediaRef.current
    if (!media) return
    media.currentTime = seconds
    setCurrentTime(seconds)
  }

  const enterFullscreen = () => {
    void containerRef.current?.requestFullscreen()
  }

  return (
    <div
      ref={containerRef}
      className="flex h-full min-h-0 w-full flex-col bg-black"
    >
      <video
        ref={mediaRef}
        key={video.id}
        src={video.path}
        poster={video.cover}
        preload="metadata"
        playsInline
        className="h-0 min-h-0 w-full flex-1 cursor-pointer object-contain"
        onClick={togglePlayback}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => {
          if (Number.isFinite(event.currentTarget.duration)) {
            setDuration(event.currentTarget.duration)
          }
        }}
        onEnded={() => {
          setPlaying(false)
          setCurrentTime(0)
          if (mediaRef.current) mediaRef.current.currentTime = 0
        }}
      />

      <div className="flex h-12 shrink-0 items-center gap-3 bg-black/90 px-3 text-white">
        <Button
          className="h-8 w-8 bg-transparent text-white hover:bg-white/15"
          onClick={togglePlayback}
          title={playing ? '暂停' : '播放'}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </Button>
        <span className="shrink-0 text-xs tabular-nums">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
        <input
          aria-label="视频进度"
          type="range"
          min={0}
          max={Math.max(duration, 0)}
          step={0.1}
          value={Math.min(currentTime, duration || 0)}
          onChange={(event) => seek(Number(event.target.value))}
          className="accent-love min-w-0 flex-1 cursor-pointer"
        />
        <Button
          className="h-8 w-8 bg-transparent text-white hover:bg-white/15"
          onClick={enterFullscreen}
          title="全屏"
        >
          <Expand className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
