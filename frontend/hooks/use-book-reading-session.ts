import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { VirtuosoHandle } from 'react-virtuoso'
import { useScrollLock } from '@/hooks/use-scroll-lock'
import { useThrottledProgress } from '@/hooks/use-throttled-progress'
import { createBookProgress } from '@/lib/progress'
import { parseBook } from '@/lib/scanner'
import { SHORTCUTS } from '@/lib/shortcuts'
import { useLibraryStore } from '@/store/library'
import { useProgressStore } from '@/store/progress'
import { useTabsStore } from '@/store/tabs'
import { LibraryType, type BookContent, type Chapter } from '@/types/library'

const EMPTY_LINES: string[] = []

interface BookData {
  bookId: string
  content: BookContent
}

interface UseBookReadingSessionOptions {
  bookId: string
}

export function useBookReadingSession({
  bookId,
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
    virtuosoRef.current?.scrollToIndex({
      index,
      align: 'start',
    })
  }
  const jumpToFn = useEffectEvent(jumpTo)

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

  useLayoutEffect(() => {
    jumpToFn()
  }, [activeTab])

  const trackRange = (range: { startIndex: number; endIndex: number }) => {
    if (isLock.current) return
    if (!book || !content) return

    const newProgress = createBookProgress(
      range.startIndex,
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
    if (activeTab && activeTab !== book.id) return

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
    trackRange,
    continueReading,
    toggleBookDeleted,
    toggleBookStarred,
    toggleChapterStarred,
  }
}
