import { useEffect, useMemo, useRef } from 'react'
import {
  createAnchor,
  indexBook,
  matchAnchor,
  type ParagraphMatch,
} from '@/lib/paragraph-anchor'
import {
  createParagraphId,
  type ParagraphFavorite,
} from '@/lib/remote-paragraphs'
import { useParagraphsStore } from '@/store/paragraphs'
import type { Book, BookContent } from '@/types/library'

const EMPTY_LINES: ReadonlySet<number> = new Set()

/**
 * Paragraph favorites for one loaded book: matches the stored anchors against
 * the current text, rewrites anchors that matched a moved or edited paragraph,
 * and flags the ones that no longer match anywhere.
 */
export function useParagraphFavorites(
  book: Book | undefined,
  content: BookContent | null,
) {
  const status = useParagraphsStore((s) => s.status)
  const paragraphs = useParagraphsStore((s) => s.paragraphs)
  const ensureLoaded = useParagraphsStore((s) => s.ensureLoaded)
  const addParagraphs = useParagraphsStore((s) => s.addParagraphs)
  const removeParagraphs = useParagraphsStore((s) => s.removeParagraphs)
  const updateParagraphs = useParagraphsStore((s) => s.updateParagraphs)
  const setMissing = useParagraphsStore((s) => s.setMissing)
  // Ids already self-healed against the current text; a failed write is not
  // retried in a loop, only after the text reloads.
  const healedRef = useRef<{ text: unknown; ids: Set<string> }>({
    text: null,
    ids: new Set(),
  })

  useEffect(() => {
    void ensureLoaded()
  }, [ensureLoaded])

  const bookTitle = book?.title
  const index = useMemo(
    () => (content ? indexBook(content.lines, content.chapters) : null),
    [content],
  )
  const favorites = useMemo(
    () =>
      bookTitle
        ? Object.values(paragraphs).filter((p) => p.bookTitle === bookTitle)
        : [],
    [bookTitle, paragraphs],
  )
  const matches = useMemo(() => {
    const result = new Map<string, ParagraphMatch | null>()
    if (!index) return result
    for (const favorite of favorites) {
      result.set(favorite.id, matchAnchor(index, favorite))
    }
    return result
  }, [favorites, index])

  // line index -> favorite ids underlined there
  const favoritesByLine = useMemo(() => {
    const result = new Map<number, string[]>()
    for (const [id, match] of matches) {
      if (!match) continue
      const ids = result.get(match.lineIndex)
      if (ids) ids.push(id)
      else result.set(match.lineIndex, [id])
    }
    return result
  }, [matches])

  const starredLines = useMemo(
    () =>
      favoritesByLine.size ? new Set(favoritesByLine.keys()) : EMPTY_LINES,
    [favoritesByLine],
  )

  useEffect(() => {
    if (!index || status !== 'ready') return
    if (healedRef.current.text !== index) {
      healedRef.current = { text: index, ids: new Set() }
    }

    const missing: Record<string, boolean> = {}
    const stale: ParagraphFavorite[] = []
    for (const favorite of favorites) {
      const match = matches.get(favorite.id)
      missing[favorite.id] = !match
      if (!match?.stale || healedRef.current.ids.has(favorite.id)) continue
      healedRef.current.ids.add(favorite.id)
      stale.push({
        id: favorite.id,
        bookTitle: favorite.bookTitle,
        createdAt: favorite.createdAt,
        ...createAnchor(index, match.lineIndex),
      })
    }
    setMissing(missing)
    if (stale.length) void updateParagraphs(stale)
  }, [favorites, index, matches, setMissing, status, updateParagraphs])

  /** Favorites the given lines; if every one already is, unfavorites them. */
  const toggleLines = (lineIndices: number[]) => {
    if (!index || !bookTitle || !lineIndices.length) return
    if (lineIndices.every((line) => favoritesByLine.has(line))) {
      void removeParagraphs(
        lineIndices.flatMap((line) => favoritesByLine.get(line) ?? []),
      )
      return
    }

    const createdAt = new Date().toISOString()
    void addParagraphs(
      lineIndices
        .filter((line) => !favoritesByLine.has(line))
        .map((line) => ({
          id: createParagraphId(),
          bookTitle,
          createdAt,
          ...createAnchor(index, line),
        })),
    )
  }

  const lineOf = (paragraphId: string) =>
    matches.get(paragraphId)?.lineIndex

  return {
    ready: status === 'ready' && Boolean(index),
    starredLines,
    toggleLines,
    lineOf,
  }
}
