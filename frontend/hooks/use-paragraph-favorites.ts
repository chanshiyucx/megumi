import { useEffect, useMemo, useRef } from 'react'
import {
  createAnchor,
  indexBook,
  matchAnchor,
  type BookParagraphIndex,
  type ParagraphMatch,
} from '@/lib/paragraph-anchor'
import {
  createParagraphId,
  type ParagraphFavorite,
} from '@/lib/remote-paragraphs'
import { useParagraphsStore } from '@/store/paragraphs'
import type { Book, BookContent } from '@/types/library'

const EMPTY_LINES: ReadonlySet<number> = new Set()

// Match results per loaded text, per favorite object. The store keeps the
// objects of untouched favorites across writes (immer), so toggling one
// paragraph only matches the new or changed anchors instead of the whole book's.
const matchCache = new WeakMap<
  BookParagraphIndex,
  WeakMap<ParagraphFavorite, ParagraphMatch | null>
>()

function cachedMatch(index: BookParagraphIndex, favorite: ParagraphFavorite) {
  let byFavorite = matchCache.get(index)
  if (!byFavorite) {
    byFavorite = new WeakMap()
    matchCache.set(index, byFavorite)
  }
  let match = byFavorite.get(favorite)
  if (match === undefined) {
    match = matchAnchor(index, favorite)
    byFavorite.set(favorite, match)
  }
  return match
}

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
  // These three stay explicit memos even with the compiler: the index is the
  // match cache's key and tells the healing below which text it last ran
  // against, and all three are that effect's dependencies, so each must
  // change only with its inputs.
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
      result.set(favorite.id, cachedMatch(index, favorite))
    }
    return result
  }, [favorites, index])

  // line index -> favorite ids underlined there
  const favoritesByLine = new Map<number, string[]>()
  for (const [id, match] of matches) {
    if (!match) continue
    const ids = favoritesByLine.get(match.lineIndex)
    if (ids) ids.push(id)
    else favoritesByLine.set(match.lineIndex, [id])
  }

  const starredLines = favoritesByLine.size
    ? new Set(favoritesByLine.keys())
    : EMPTY_LINES

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
