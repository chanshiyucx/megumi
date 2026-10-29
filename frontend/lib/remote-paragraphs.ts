import type { ParagraphAnchor } from '@/lib/paragraph-anchor'

export interface ParagraphFavorite extends ParagraphAnchor {
  id: string
  bookTitle: string
  createdAt: string
}

export type RemoteParagraphMutation =
  | { operation: 'add'; paragraph: ParagraphFavorite }
  | { operation: 'update'; paragraph: ParagraphFavorite }
  | { operation: 'remove'; id: string }

let paragraphWriteQueue = Promise.resolve()

function paragraphsApiUrl() {
  return process.env.NEXT_PUBLIC_MEGUMI_TAGS_API_URL?.replace(/\/$/, '') ?? ''
}

function normalizeParagraph(value: unknown): ParagraphFavorite | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Partial<ParagraphFavorite>
  if (
    typeof source.id !== 'string' ||
    typeof source.bookTitle !== 'string' ||
    typeof source.text !== 'string' ||
    typeof source.createdAt !== 'string' ||
    typeof source.lineIndex !== 'number' ||
    typeof source.lineCount !== 'number'
  ) {
    return null
  }

  const paragraph: ParagraphFavorite = {
    id: source.id,
    bookTitle: source.bookTitle,
    text: source.text,
    lineIndex: source.lineIndex,
    lineCount: source.lineCount,
    createdAt: source.createdAt,
  }
  if (typeof source.prev === 'string') paragraph.prev = source.prev
  if (typeof source.next === 'string') paragraph.next = source.next
  if (typeof source.chapterTitle === 'string') {
    paragraph.chapterTitle = source.chapterTitle
  }
  return paragraph
}

function normalizeRemoteParagraphs(value: unknown) {
  const paragraphs: Record<string, ParagraphFavorite> = {}
  const source =
    value && typeof value === 'object'
      ? (value as { paragraphs?: unknown }).paragraphs
      : undefined
  if (source && typeof source === 'object') {
    for (const entry of Object.values(source)) {
      const paragraph = normalizeParagraph(entry)
      if (paragraph) paragraphs[paragraph.id] = paragraph
    }
  }
  return paragraphs
}

async function patchRemoteParagraphs(mutations: RemoteParagraphMutation[]) {
  const baseUrl = paragraphsApiUrl()
  if (!baseUrl) {
    throw new Error('NEXT_PUBLIC_MEGUMI_TAGS_API_URL is not configured')
  }

  const response = await fetch(`${baseUrl}/paragraphs`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mutations),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${baseUrl}/paragraphs`)
  }
  return normalizeRemoteParagraphs(await response.json())
}

// Writes go out one at a time and in order, so an add is never overtaken by
// its own remove; reads wait for pending writes.
export function queueRemoteParagraphMutations(
  mutations: RemoteParagraphMutation[],
) {
  const pending = paragraphWriteQueue.then(() =>
    patchRemoteParagraphs(mutations),
  )
  paragraphWriteQueue = pending.then(
    () => undefined,
    () => undefined,
  )
  return pending
}

export async function fetchRemoteParagraphs() {
  await paragraphWriteQueue

  const baseUrl = paragraphsApiUrl()
  if (!baseUrl) return {}

  const response = await fetch(`${baseUrl}/paragraphs`, { cache: 'no-cache' })
  if (response.status === 404) return {}
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${baseUrl}/paragraphs`)
  }
  return normalizeRemoteParagraphs(await response.json())
}

export function createParagraphId() {
  // randomUUID needs a secure context; plain-http LAN access (e.g. an iPad on
  // the dev server) falls back to a time + random id.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    try {
      return crypto.randomUUID()
    } catch {
      // fall through
    }
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}
