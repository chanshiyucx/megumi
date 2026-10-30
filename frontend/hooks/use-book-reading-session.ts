import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { VirtuosoHandle } from 'react-virtuoso'
import { useParagraphFavorites } from '@/hooks/use-paragraph-favorites'
import { useScrollLock } from '@/hooks/use-scroll-lock'
import { useThrottledProgress } from '@/hooks/use-throttled-progress'
import { createBookProgress } from '@/lib/progress'
import { parseBook } from '@/lib/scanner'
import { SHORTCUTS } from '@/lib/shortcuts'
import { useLibraryStore } from '@/store/library'
import { useProgressStore } from '@/store/progress'
import { useTabsStore } from '@/store/tabs'
import {
  LibraryType,
  type BookContent,
  type Chapter,
  type JumpRequest,
} from '@/types/library'

const EMPTY_LINES: string[] = []
const JUMP_REALIGN_FRAMES = 10

interface BookData {
  bookId: string
  content: BookContent
}

interface UseBookReadingSessionOptions {
  bookId: string
  surface: 'library' | 'tab'
  // Moves the reader to a line once that book's content is loaded.
  jumpRequest?: JumpRequest
}

export function useBookReadingSession({
  bookId,
  surface,
  jumpRequest,
}: UseBookReadingSessionOptions) {
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const [isTocCollapsed, setTocCollapsed] = useState(true)
  const [bookData, setBookData] = useState<BookData | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [loadProgress, setLoadProgress] = useState(0)

  const book = useLibraryStore((s) => s.books[bookId])
  const updateBookTags = useLibraryStore((s) => s.updateBookTags)
  const updateBookChapterTags = useLibraryStore(
    (s) => s.updateBookChapterTags,
  )
  const getBookChapters = useLibraryStore((s) => s.getBookChapters)
  const bookRefreshToken = useLibraryStore(
    (s) => s.bookRefreshTokens[bookId] ?? 0,
  )
  const activeTab = useTabsStore((s) => s.activeTab)
  const addTab = useTabsStore((s) => s.addTab)
  const setActiveTab = useTabsStore((s) => s.setActiveTab)

  const content = bookData?.bookId === bookId ? bookData.content : null
  const lines = content?.lines ?? EMPTY_LINES

  const updateBookProgress = useProgressStore((s) => s.updateBookProgress)
  const progress = useProgressStore((s) => s.books[bookId])
  const currentIndex = progress?.current ?? 0
  const currentChapterTitle = progress?.currentChapterTitle ?? ''

  const { isLock, lockScroll } = useScrollLock()
  const throttledUpdateProgress = useThrottledProgress(updateBookProgress)
  const refreshTokenRef = useRef({ bookId, token: bookRefreshToken })
  const handledJumpRef = useRef(0)
  const realignFrameRef = useRef<number | null>(null)

  const jumpTo = (targetIndex?: number) => {
    if (!book || !content) return

    const index = targetIndex ?? currentIndex
    const newProgress = createBookProgress(
      index,
      content.lines.length,
      content.chapters,
    )
    updateBookProgress(book.id, newProgress)

    lockScroll()
    const scrollToLine = () => {
      virtuosoRef.current?.scrollToIndex({ index, align: 'start' })
    }
    scrollToLine()
    // A long jump scrolls by estimated heights and stops short once the lines
    // around the target are measured; keep aiming for a few frames until they
    // are. Aiming at a line already at the top does not move the list.
    if (realignFrameRef.current !== null) {
      cancelAnimationFrame(realignFrameRef.current)
    }
    let frames = 0
    const realign = () => {
      scrollToLine()
      frames += 1
      realignFrameRef.current =
        frames < JUMP_REALIGN_FRAMES ? requestAnimationFrame(realign) : null
    }
    realignFrameRef.current = requestAnimationFrame(realign)
  }
  const jumpToFn = useEffectEvent(jumpTo)

  const paragraphFavorites = useParagraphFavorites(book, content)
  const resolveJump = useEffectEvent((request: JumpRequest) => {
    if (!request.paragraphId) return request.index
    return paragraphFavorites.lineOf(request.paragraphId)
  })

  useEffect(() => {
    if (!jumpRequest || jumpRequest.id !== bookId) return
    if (handledJumpRef.current === jumpRequest.seq || !content) return
    // A paragraph jump waits until favorites are loaded and matched; one whose
    // paragraph is gone from the text is dropped.
    if (jumpRequest.paragraphId && !paragraphFavorites.ready) return
    handledJumpRef.current = jumpRequest.seq
    const index = resolveJump(jumpRequest)
    if (index !== undefined) jumpToFn(index)
  }, [bookId, content, jumpRequest, paragraphFavorites.ready])

  useEffect(() => {
    if (!book?.path) return

    const previousRefresh = refreshTokenRef.current
    const force =
      previousRefresh.bookId === bookId &&
      bookRefreshToken > previousRefresh.token
    refreshTokenRef.current = { bookId, token: bookRefreshToken }

    let cancelled = false
    const load = async () => {
      setIsLoading(true)
      setLoadProgress(0)
      try {
        const [data, chapters] = await Promise.all([
          parseBook(book.path, (percent) => {
            if (!cancelled) setLoadProgress(percent)
          }),
          getBookChapters(bookId, { force }),
        ])
        data.chapters = chapters
        if (!cancelled) setBookData({ bookId, content: data })
      } catch (e) {
        console.error('Failed to load book', e)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [bookId, book?.path, bookRefreshToken, getBookChapters])

  useLayoutEffect(() => {
    lockScroll()
  }, [lockScroll, bookId])

  // The library reuses this reader across books and virtuosoRef follows the
  // new list, so a pending realign must not outlive the book it aims into.
  useEffect(
    () => () => {
      if (realignFrameRef.current !== null) {
        cancelAnimationFrame(realignFrameRef.current)
        realignFrameRef.current = null
      }
    },
    [bookId],
  )

  useLayoutEffect(() => {
    if (surface === 'tab' && activeTab !== bookId) return
    if (surface === 'library' && activeTab) return
    jumpToFn()
  }, [activeTab, bookId, surface])

  const trackTopLine = (lineIndex: number) => {
    if (isLock.current) return
    if (!book || !content) return

    const newProgress = createBookProgress(
      lineIndex,
      content.lines.length,
      content.chapters,
    )
    throttledUpdateProgress.current(book.id, newProgress)
  }

  const closeToc = () => {
    setTocCollapsed(true)
  }

  const toggleToc = () => {
    if (!content?.chapters.length) return
    setTocCollapsed((prev) => !prev)
  }

  const continueReading = () => {
    if (!book || activeTab === book.id) return
    addTab({
      type: LibraryType.book,
      id: book.id,
      title: book.title,
    })
    setActiveTab(book.id)
  }

  const toggleBookDeleted = () => {
    if (!book) return
    void updateBookTags(book.id, { deleted: !book.deleted })
  }

  const toggleBookStarred = () => {
    if (!book) return
    void updateBookTags(book.id, { starred: !book.starred })
  }

  const toggleChapterStarred = (chapter: Chapter) => {
    void updateBookChapterTags(bookId, chapter.lineIndex, {
      starred: !chapter.starred,
    })
  }

  const handleKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (!book) return
    if (surface === 'tab' && activeTab !== book.id) return
    if (surface === 'library' && activeTab) return

    switch (e.code) {
      case SHORTCUTS.toggleToc:
        toggleToc()
        break
      case SHORTCUTS.toggleItemDeleted:
        toggleBookDeleted()
        break
      case SHORTCUTS.toggleItemStarred:
        toggleBookStarred()
        break
      case SHORTCUTS.continueReading:
        continueReading()
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
    book,
    content,
    lines,
    progress,
    currentIndex,
    currentChapterTitle,
    isLoading,
    loadProgress,
    isTocCollapsed,
    virtuosoRef,
    closeToc,
    toggleToc,
    jumpTo,
    trackTopLine,
    continueReading,
    toggleBookDeleted,
    toggleBookStarred,
    toggleChapterStarred,
    starredLines: paragraphFavorites.starredLines,
    toggleLines: paragraphFavorites.toggleLines,
  }
}
