/**
 * Paragraph anchors: how a favorited book paragraph is found again after the
 * book text changes (content appended, re-formatted, lightly edited).
 *
 * A paragraph is one non-empty line of the book (the reader's `lines`). Its
 * anchor stores the normalized text plus a little context; the line index is
 * only a hint. Matching tries, in order:
 *
 * 1. the same normalized text — unique hit wins; duplicates are told apart by
 *    neighbour context, chapter and closeness to the old relative position;
 * 2. a fuzzy match inside the anchor's chapter (or a window around its old
 *    position): one paragraph contains the other (split / merged paragraphs)
 *    or their character bigrams are similar enough (small edits).
 *
 * This module is pure so the matching rules can be exercised in isolation.
 */

export interface ParagraphAnchor {
  // Normalized paragraph text.
  text: string
  // First CONTEXT_LENGTH characters of the neighbouring paragraphs.
  prev?: string
  next?: string
  chapterTitle?: string
  // Position when the anchor was last written; a hint, not an identity.
  lineIndex: number
  lineCount: number
}

export interface ParagraphChapter {
  title: string
  lineIndex: number
}

export interface BookParagraphIndex {
  normalized: string[]
  byText: Map<string, number[]>
  chapters: ParagraphChapter[]
}

export interface ParagraphMatch {
  lineIndex: number
  // True when the anchor no longer describes the matched paragraph exactly
  // (text, context, chapter or position moved) and should be rewritten.
  stale: boolean
}

const CONTEXT_LENGTH = 32
// Shorter paragraphs ("嗯。", "……") are too ambiguous to match fuzzily.
const MIN_FUZZY_LENGTH = 8
const MIN_SIMILARITY = 0.75
// Fuzzy search window around the expected position when the chapter is gone.
const MIN_FUZZY_WINDOW = 300
const FUZZY_WINDOW_RATIO = 0.05

/** Whitespace-insensitive, width-insensitive form used for all comparisons. */
export function normalizeParagraph(line: string) {
  return line.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

function contextOf(normalized: string[], index: number) {
  const value = normalized[index]
  return value ? value.slice(0, CONTEXT_LENGTH) : undefined
}

function chapterAt(chapters: ParagraphChapter[], lineIndex: number) {
  return chapters.findLast((chapter) => chapter.lineIndex <= lineIndex)
}

export function indexBook(
  lines: readonly string[],
  chapters: ParagraphChapter[],
): BookParagraphIndex {
  const normalized = lines.map(normalizeParagraph)
  const byText = new Map<string, number[]>()
  normalized.forEach((text, index) => {
    if (!text) return
    const indices = byText.get(text)
    if (indices) indices.push(index)
    else byText.set(text, [index])
  })
  return { normalized, byText, chapters }
}

export function createAnchor(
  book: BookParagraphIndex,
  lineIndex: number,
): ParagraphAnchor {
  const anchor: ParagraphAnchor = {
    text: book.normalized[lineIndex],
    lineIndex,
    lineCount: book.normalized.length,
  }
  const prev = contextOf(book.normalized, lineIndex - 1)
  const next = contextOf(book.normalized, lineIndex + 1)
  const chapterTitle = chapterAt(book.chapters, lineIndex)?.title
  if (prev) anchor.prev = prev
  if (next) anchor.next = next
  if (chapterTitle) anchor.chapterTitle = chapterTitle
  return anchor
}

function expectedIndex(book: BookParagraphIndex, anchor: ParagraphAnchor) {
  const total = book.normalized.length
  if (anchor.lineCount <= 0 || total <= 0) return anchor.lineIndex
  return Math.round((anchor.lineIndex / anchor.lineCount) * total)
}

function contextScore(
  book: BookParagraphIndex,
  anchor: ParagraphAnchor,
  index: number,
) {
  let score = 0
  if (anchor.prev && contextOf(book.normalized, index - 1) === anchor.prev) {
    score += 2
  }
  if (anchor.next && contextOf(book.normalized, index + 1) === anchor.next) {
    score += 2
  }
  if (
    anchor.chapterTitle &&
    chapterAt(book.chapters, index)?.title === anchor.chapterTitle
  ) {
    score += 1
  }
  return score
}

// Highest score wins; ties go to the candidate nearest the expected position.
function pickBest(
  candidates: { index: number; score: number }[],
  expected: number,
) {
  let best: { index: number; score: number } | undefined
  for (const candidate of candidates) {
    if (
      !best ||
      candidate.score > best.score ||
      (candidate.score === best.score &&
        Math.abs(candidate.index - expected) < Math.abs(best.index - expected))
    ) {
      best = candidate
    }
  }
  return best
}

function bigrams(text: string) {
  const counts = new Map<string, number>()
  for (let i = 0; i < text.length - 1; i += 1) {
    const gram = text.slice(i, i + 2)
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  return counts
}

// Sørensen–Dice coefficient over character bigrams (0..1).
function similarity(a: Map<string, number>, aSize: number, text: string) {
  const b = bigrams(text)
  const bSize = Math.max(0, text.length - 1)
  if (!aSize || !bSize) return 0
  let overlap = 0
  for (const [gram, count] of b) overlap += Math.min(count, a.get(gram) ?? 0)
  return (2 * overlap) / (aSize + bSize)
}

function fuzzyRange(
  book: BookParagraphIndex,
  anchor: ParagraphAnchor,
  expected: number,
) {
  const total = book.normalized.length
  const sameTitle = book.chapters
    .map((chapter, i) => ({ chapter, i }))
    .filter(({ chapter }) => chapter.title === anchor.chapterTitle)
  if (anchor.chapterTitle && sameTitle.length) {
    const nearest = sameTitle.reduce((a, b) =>
      Math.abs(b.chapter.lineIndex - expected) <
      Math.abs(a.chapter.lineIndex - expected)
        ? b
        : a,
    )
    const start = nearest.chapter.lineIndex
    const end = book.chapters[nearest.i + 1]?.lineIndex ?? total
    return [start, end] as const
  }
  const window = Math.max(MIN_FUZZY_WINDOW, Math.round(total * FUZZY_WINDOW_RATIO))
  return [Math.max(0, expected - window), Math.min(total, expected + window)] as const
}

function fuzzyMatch(
  book: BookParagraphIndex,
  anchor: ParagraphAnchor,
  expected: number,
) {
  const text = anchor.text
  if (text.length < MIN_FUZZY_LENGTH) return undefined

  const grams = bigrams(text)
  const gramCount = text.length - 1
  const [start, end] = fuzzyRange(book, anchor, expected)
  const candidates: { index: number; score: number }[] = []

  for (let index = start; index < end; index += 1) {
    const candidate = book.normalized[index]
    if (!candidate) continue

    const [shorter, longer] =
      candidate.length < text.length ? [candidate, text] : [text, candidate]
    let score = 0
    if (shorter.length >= MIN_FUZZY_LENGTH && longer.includes(shorter)) {
      // Split or merged paragraph: the closer the lengths, the stronger.
      score = 0.8 + 0.2 * (shorter.length / longer.length)
    } else if (
      candidate.length * 3 >= text.length &&
      text.length * 3 >= candidate.length
    ) {
      score = similarity(grams, gramCount, candidate)
    }
    if (score >= MIN_SIMILARITY) {
      // Matching neighbours / chapter outweigh small similarity differences
      // (up to +0.125), so a lookalike paragraph elsewhere loses to the one
      // still sitting in its old context.
      candidates.push({
        index,
        score: score + contextScore(book, anchor, index) / 40,
      })
    }
  }

  return pickBest(candidates, expected)
}

function isStale(
  book: BookParagraphIndex,
  anchor: ParagraphAnchor,
  index: number,
) {
  const current = createAnchor(book, index)
  return (
    current.text !== anchor.text ||
    current.prev !== anchor.prev ||
    current.next !== anchor.next ||
    current.chapterTitle !== anchor.chapterTitle ||
    current.lineIndex !== anchor.lineIndex ||
    current.lineCount !== anchor.lineCount
  )
}

export function matchAnchor(
  book: BookParagraphIndex,
  anchor: ParagraphAnchor,
): ParagraphMatch | null {
  const expected = expectedIndex(book, anchor)
  const exact = book.byText.get(anchor.text)

  const best = exact?.length
    ? pickBest(
        exact.map((index) => ({
          index,
          score: contextScore(book, anchor, index),
        })),
        expected,
      )
    : fuzzyMatch(book, anchor, expected)

  if (!best) return null
  return { lineIndex: best.index, stale: isStale(book, anchor, best.index) }
}
