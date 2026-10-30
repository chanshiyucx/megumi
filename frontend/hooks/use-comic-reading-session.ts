import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react'
import type { ComicStripHandle } from '@/components/ui/comic-strip'
import { createComicProgress } from '@/lib/progress'
import { SHORTCUTS } from '@/lib/shortcuts'
import { useLibraryStore } from '@/store/library'
import { useProgressStore, watchProgress } from '@/store/progress'
import { useTabsStore } from '@/store/tabs'
import type { ComicLibraryViewMode } from '@/store/ui'
import {
  LibraryType,
  type ComicImageStatus,
  type FileTags,
  type Image,
} from '@/types/library'

const EMPTY_ARRAY: Image[] = []

type StripRef = RefObject<ComicStripHandle | null>

type ComicTagTargetPolicy = 'reader' | 'library-grid' | 'library-scroll'

type ComicReadingSurface =
  | {
      kind: 'reader'
    }
  | {
      kind: 'library'
      readerVisible: boolean
      viewMode: ComicLibraryViewMode
      onToggleViewMode: () => void
    }

interface UseComicReadingSessionOptions {
  comicId: string
  stripRef: StripRef
  surface: ComicReadingSurface
  onToggleToc?: () => void
}

function clampIndex(index: number, total: number) {
  return Math.max(0, Math.min(total - 1, index))
}

function resolveTagTargetImage(
  policy: ComicTagTargetPolicy,
  images: Image[],
  previewIndex: number,
  hoveredIndex: number | null,
  currentIndex: number,
) {
  if (previewIndex >= 0) {
    return images[previewIndex]
  }
  if (policy === 'library-grid') {
    return undefined
  }
  return images[hoveredIndex ?? currentIndex]
}

export function useComicReadingSession({
  comicId,
  stripRef,
  surface,
  onToggleToc,
}: UseComicReadingSessionOptions) {
  const comic = useLibraryStore((s) => s.comics[comicId])
  const comicImages = useLibraryStore((s) => s.comicImages[comicId])
  const images = comicImages?.images ?? EMPTY_ARRAY
  const comicImageStatus: ComicImageStatus = comicImages?.status ?? 'idle'
  const getComicImages = useLibraryStore((s) => s.getComicImages)
  const updateComicTags = useLibraryStore((s) => s.updateComicTags)
  const updateComicImageTags = useLibraryStore((s) => s.updateComicImageTags)
  const activeTab = useTabsStore((s) => s.activeTab)

  const updateComicProgress = useProgressStore((s) => s.updateComicProgress)
  const progress = useProgressStore((s) => s.comics[comicId])
  const remoteProgress = useProgressStore((s) => s.remote.comics[comicId])
  const acceptRemote = useProgressStore((s) => s.acceptRemote)
  const dismissRemote = useProgressStore((s) => s.dismissRemote)
  const savedIndex = progress?.current ?? 0
  // Whether the page strip is in view: the reader tab in front, or the
  // library's strip with no tab over it. It then shows the comic's reading
  // position, so another device's newer one is offered instead of applied.
  const stripVisible =
    surface.kind === 'reader'
      ? activeTab === comicId
      : surface.readerVisible && surface.viewMode === 'scroll' && !activeTab
  const tagTargetPolicy: ComicTagTargetPolicy =
    surface.kind === 'reader'
      ? 'reader'
      : surface.viewMode === 'grid'
        ? 'library-grid'
        : 'library-scroll'
  const previewActive =
    surface.kind === 'reader'
      ? activeTab === comicId
      : !activeTab && surface.readerVisible

  const [previewIndex, setPreviewIndex] = useState(-1)
  const currentIndex = images.length
    ? clampIndex(savedIndex, images.length)
    : savedIndex
  const currentIndexRef = useRef(currentIndex)
  const hoveredIndexRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    currentIndexRef.current = currentIndex
  }, [currentIndex])

  useEffect(() => {
    if (!stripVisible) return
    return watchProgress('comics', comicId)
  }, [comicId, stripVisible])

  const comicPath = comic?.path
  useEffect(() => {
    if (!comicPath || comicImageStatus !== 'idle') return
    void getComicImages(comicId)
  }, [comicId, comicImageStatus, comicPath, getComicImages])

  // A strip coming back into view is still where it was left, to the pixel.
  // Move it only if the position changed meanwhile: read in another tab or
  // the library, or taken from another device while out of view.
  useLayoutEffect(() => {
    if (!stripVisible || !images.length) return
    const strip = stripRef.current
    if (strip && strip.currentIndex() !== currentIndexRef.current) {
      strip.jumpTo(currentIndexRef.current)
    }
  }, [comicId, images.length, stripRef, stripVisible])

  const saveIndex = (index: number) => {
    if (!comic || !images.length) return
    updateComicProgress(comic.id, createComicProgress(index, images.length))
  }

  useEffect(() => {
    if (!comic || !images.length) return
    const nextIndex = clampIndex(savedIndex, images.length)
    if (nextIndex === savedIndex) return
    updateComicProgress(
      comic.id,
      createComicProgress(nextIndex, images.length),
    )
  }, [comic, images.length, savedIndex, updateComicProgress])

  const jumpTo = (index?: number) => {
    if (!comic || !images.length) return

    const nextIndex = clampIndex(
      index ?? currentIndexRef.current,
      images.length,
    )
    saveIndex(nextIndex)
    stripRef.current?.jumpTo(nextIndex)
  }

  const trackStripIndex = (index: number) => {
    if (!stripVisible) return
    saveIndex(index)
  }

  const jumpToRemote = () => {
    if (!remoteProgress) return
    acceptRemote('comics', comicId)
    jumpTo(remoteProgress.current)
  }

  const keepLocalPosition = () => {
    dismissRemote('comics', comicId)
  }

  const setHoveredIndex = (index: number | null) => {
    hoveredIndexRef.current = index
  }

  const getTagTargetImage = () =>
    resolveTagTargetImage(
      tagTargetPolicy,
      images,
      previewIndex,
      hoveredIndexRef.current,
      currentIndex,
    )

  const updateTargetImageTags = (tagsFor: (image: Image) => FileTags) => {
    if (!comic) return

    const targetImage = getTagTargetImage()
    if (!targetImage) return

    void updateComicImageTags(
      comic.id,
      targetImage.path,
      tagsFor(targetImage),
    )
  }

  const toggleTargetImageDeleted = () => {
    updateTargetImageTags((image) => ({ deleted: !image.deleted }))
  }

  const toggleTargetImageStarred = () => {
    updateTargetImageTags((image) => ({ starred: !image.starred }))
  }

  const toggleComicDeleted = () => {
    if (!comic) return
    void updateComicTags(comic.id, { deleted: !comic.deleted })
  }

  const toggleComicStarred = () => {
    if (!comic) return
    void updateComicTags(comic.id, { starred: !comic.starred })
  }

  const continueReading = () => {
    if (!comic || activeTab === comic.id) return
    useTabsStore.getState().addTab({
      type: LibraryType.comic,
      id: comic.id,
      title: comic.title,
    })
  }

  const closePreview = () => {
    if (previewIndex >= 0 && images.length) {
      const nextIndex = clampIndex(previewIndex, images.length)
      saveIndex(nextIndex)
      if (stripVisible) stripRef.current?.jumpTo(nextIndex)
    }
    setPreviewIndex(-1)
  }

  // ←/→ move the strip one page. The browser's own small arrow scroll is
  // stopped; while the preview is open it pages the preview (its own listener)
  // instead. Holding the key steps once: auto-repeat would chain steps onto a
  // moving target and jitter, then land many pages on.
  const stepStrip = (e: KeyboardEvent) => {
    e.preventDefault()
    if (previewIndex >= 0 || e.repeat) return
    stripRef.current?.step(e.code === SHORTCUTS.nextImage ? 1 : -1)
  }

  const handleKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (!comic) return

    if (surface.kind === 'reader') {
      if (activeTab !== comic.id) return

      switch (e.code) {
        case SHORTCUTS.toggleToc:
          onToggleToc?.()
          break
        case SHORTCUTS.toggleItemDeleted:
          toggleComicDeleted()
          break
        case SHORTCUTS.toggleItemStarred:
          toggleComicStarred()
          break
        case SHORTCUTS.toggleImageDeleted:
          toggleTargetImageDeleted()
          break
        case SHORTCUTS.toggleImageStarred:
          toggleTargetImageStarred()
          break
        case SHORTCUTS.prevImage:
        case SHORTCUTS.nextImage:
          stepStrip(e)
          break
      }
      return
    }

    if (activeTab) return

    switch (e.code) {
      case SHORTCUTS.continueReading:
        continueReading()
        break
      case SHORTCUTS.toggleViewMode:
        surface.onToggleViewMode()
        break
      case SHORTCUTS.toggleItemDeleted:
        toggleComicDeleted()
        break
      case SHORTCUTS.toggleItemStarred:
        toggleComicStarred()
        break
      case SHORTCUTS.toggleImageDeleted:
        toggleTargetImageDeleted()
        break
      case SHORTCUTS.toggleImageStarred:
        toggleTargetImageStarred()
        break
      case SHORTCUTS.prevImage:
      case SHORTCUTS.nextImage:
        if (stripVisible) stepStrip(e)
        break
    }
  })

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  return {
    comic,
    images,
    comicImageStatus,
    currentIndex,
    previewIndex,
    setPreviewIndex,
    previewActive,
    jumpTo,
    trackStripIndex,
    setHoveredIndex,
    closePreview,
    continueReading,
    remoteProgress,
    jumpToRemote,
    keepLocalPosition,
    toggleComicDeleted,
    toggleComicStarred,
    updateComicImageTags,
  }
}
