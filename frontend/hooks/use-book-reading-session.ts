import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { BookTextHandle } from '@/components/layout/book-reader'
import { useParagraphFavorites } from '@/hooks/use-paragraph-favorites'
import { createBookProgress } from '@/lib/progress'
import { parseBook } from '@/lib/scanner'
import { SHORTCUTS } from '@/lib/shortcuts'
import { useLibraryStore } from '@/store/library'
import { useProgressStore, watchProgress } from '@/store/progress'
import { useTabsStore } from '@/store/tabs'
import {
  LibraryType,
  type BookContent,
  type Chapter,
  type JumpRequest,
} from '@/types/library'

const EMPTY_LINES: string[] = []

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
  const bookTextRef = useRef<BookTextHandle>(null)
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
  // Only what the header and TOC show is subscribed to: the position itself
  // changes with every line scrolled past.
  const currentChapterTitle = useProgressStore(
    (s) => s.books[bookId]?.currentChapterTitle ?? '',
  )
  const percent = useProgressStore((s) =>
    Math.round(s.books[bookId]?.percent ?? 0),
  )
  const remoteProgress = useProgressStore((s) => s.remote.books[bookId])
  const acceptRemote = useProgressStore((s) => s.acceptRemote)
  const dismissRemote = useProgressStore((s) => s.dismissRemote)
  // The reader is on screen: the tab in front, or the library with no tab
  // over it. Another device's newer position is then offered, not applied.
  const showsPosition = surface === 'tab' ? activeTab === bookId : !activeTab

  const refreshTokenRef = useRef({ bookId, token: bookRefreshToken })
  const handledJumpRef = useRef(0)
  // The line the text has at the top, last reported or jumped to, and the
  // loaded text it is a line of.
  const shownRef = useRef<{ content: BookContent; line: number } | null>(null)

  const jumpTo = (targetIndex?: number) => {
    if (!book || !content) return

    // Read the store, not this render: a jump request and the restore after
    // loading run in the same commit, and the restore must aim where the
    // jump just moved the progress rather than where it was before.
    const index =
      targetIndex ?? useProgressStore.getState().books[bookId]?.current ?? 0
    const newProgress = createBookProgress(
      index,
      content.lines.length,
      content.chapters,
    )
    updateBookProgress(book.id, newProgress)
    shownRef.current = { content, line: index }
    bookTextRef.current?.scrollToLine(index)
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
          parseBook(book.path, {
            force,
            onProgress: (percent) => {
              if (!cancelled) setLoadProgress(percent)
            },
          }),
          getBookChapters(bookId, { force }),
        ])
        // The parsed text is shared with other readers of this book.
        const content = { lines: data.lines, chapters }
        if (!cancelled) setBookData({ bookId, content })
      } catch (e) {
        console.error('Failed to load book', e)
      }
      // Not in a finally block: the React Compiler skips functions with one.
      if (!cancelled) setIsLoading(false)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [bookId, book?.path, bookRefreshToken, getBookChapters])

  useEffect(() => {
    if (!showsPosition) return
    return watchProgress('books', bookId)
  }, [bookId, showsPosition])

  // A text just loaded opens at the saved line. One coming back into view is
  // still where it was left, to the pixel; aiming at the saved line again
  // would drop the part of it scrolled past, so it moves only if the position
  // changed meanwhile: read in another tab or the library, or taken from
  // another device while out of view.
  useLayoutEffect(() => {
    if (!showsPosition || !content) return
    const shown = shownRef.current
    const saved = useProgressStore.getState().books[bookId]?.current ?? 0
    if (shown?.content !== content || shown.line !== saved) jumpToFn()
  }, [bookId, content, showsPosition])

  const trackTopLine = (lineIndex: number) => {
    if (!book || !content) return

    shownRef.current = { content, line: lineIndex }
    const newProgress = createBookProgress(
      lineIndex,
      content.lines.length,
      content.chapters,
    )
    updateBookProgress(book.id, newProgress)
  }

  const jumpToRemote = () => {
    if (!remoteProgress || !content) return
    acceptRemote('books', bookId)
    jumpTo(Math.min(remoteProgress.current, content.lines.length - 1))
  }

  const keepLocalPosition = () => {
    dismissRemote('books', bookId)
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
    percent,
    currentChapterTitle,
    isLoading,
    loadProgress,
    isTocCollapsed,
    bookTextRef,
    closeToc,
    toggleToc,
    jumpTo,
    trackTopLine,
    continueReading,
    toggleBookDeleted,
    toggleBookStarred,
    toggleChapterStarred,
    remoteProgress,
    jumpToRemote,
    keepLocalPosition,
    starredLines: paragraphFavorites.starredLines,
    toggleLines: paragraphFavorites.toggleLines,
  }
}
