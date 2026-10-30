import type { BookProgress, ComicProgress } from '@/types/library'

export interface ProgressSnapshot {
  comics: Record<string, ComicProgress>
  books: Record<string, BookProgress>
}

export type ProgressCollection = keyof ProgressSnapshot

export const PROGRESS_COLLECTIONS: ProgressCollection[] = ['comics', 'books']

function progressApiUrl() {
  return process.env.NEXT_PUBLIC_MEGUMI_TAGS_API_URL?.replace(/\/$/, '') ?? ''
}

export function isProgressSyncEnabled() {
  return Boolean(progressApiUrl())
}

export function emptyProgressSnapshot(): ProgressSnapshot {
  return { comics: {}, books: {} }
}

function normalizeEntry(value: unknown): BookProgress | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Partial<BookProgress>
  if (
    typeof source.current !== 'number' ||
    typeof source.total !== 'number' ||
    typeof source.percent !== 'number' ||
    typeof source.lastRead !== 'number'
  ) {
    return null
  }

  const entry: BookProgress = {
    current: source.current,
    total: source.total,
    percent: source.percent,
    lastRead: source.lastRead,
  }
  if (typeof source.currentChapterTitle === 'string') {
    entry.currentChapterTitle = source.currentChapterTitle
  }
  return entry
}

function normalizeSnapshot(value: unknown): ProgressSnapshot {
  const snapshot = emptyProgressSnapshot()
  if (!value || typeof value !== 'object') return snapshot
  for (const collection of PROGRESS_COLLECTIONS) {
    const source = (value as Partial<Record<ProgressCollection, unknown>>)[
      collection
    ]
    if (!source || typeof source !== 'object') continue
    for (const [id, entry] of Object.entries(source)) {
      const normalized = normalizeEntry(entry)
      if (normalized) snapshot[collection][id] = normalized
    }
  }
  return snapshot
}

export async function fetchRemoteProgress() {
  const baseUrl = progressApiUrl()
  if (!baseUrl) return emptyProgressSnapshot()

  const response = await fetch(`${baseUrl}/progress`, { cache: 'no-cache' })
  if (response.status === 404) return emptyProgressSnapshot()
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${baseUrl}/progress`)
  }
  return normalizeSnapshot(await response.json())
}

/**
 * Sends entries for the Worker to keep where they are newer than its own, and
 * returns what it holds for those ids afterwards. `keepalive` is for a page
 * being hidden or closed: it goes out as a plain-text POST, which needs no
 * CORS preflight, so the browser can finish it after the page is gone.
 */
export async function pushRemoteProgress(
  patch: ProgressSnapshot,
  { keepalive = false }: { keepalive?: boolean } = {},
) {
  const baseUrl = progressApiUrl()
  if (!baseUrl) {
    throw new Error('NEXT_PUBLIC_MEGUMI_TAGS_API_URL is not configured')
  }

  const body = JSON.stringify(patch)
  const response = await fetch(
    `${baseUrl}/progress`,
    keepalive
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body,
          keepalive: true,
        }
      : {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body,
        },
  )
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${baseUrl}/progress`)
  }
  return normalizeSnapshot(await response.json())
}
