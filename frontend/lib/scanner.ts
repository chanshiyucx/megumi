import type { BookContent } from '@/types/library'

// Parsed texts kept in memory, most recently used last. Book URLs carry the
// file's mtime, so an entry never goes stale; the cap bounds memory when
// several long books are open.
const MAX_CACHED_BOOKS = 3

interface BookLoad {
  content: Promise<BookContent>
  listeners: Set<(percent: number) => void>
}

const bookLoads = new Map<string, BookLoad>()

function parseBookText(text: string): BookContent {
  const lines: string[] = []

  for (const sourceLine of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (!sourceLine.trim()) continue
    lines.push(sourceLine)
  }

  return { lines, chapters: [] }
}

async function fetchBook(
  url: string,
  onProgress: (percent: number) => void,
): Promise<BookContent> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const total = Number(res.headers.get('content-length')) || 0
  if (!total || !res.body) {
    const result = parseBookText(await res.text())
    onProgress(100)
    return result
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.length
    text += decoder.decode(value, { stream: true })
    onProgress(Math.min(99, Math.round((received / total) * 100)))
  }
  text += decoder.decode()

  const result = parseBookText(text)
  onProgress(100)
  return result
}

/**
 * Loads and parses a book's text. Readers of the same book (library preview
 * and tab) share one download and one parsed copy; `force` reloads it. The
 * returned content is shared, so callers must not mutate it.
 */
export async function parseBook(
  url: string,
  {
    force = false,
    onProgress,
  }: { force?: boolean; onProgress?: (percent: number) => void } = {},
): Promise<BookContent> {
  let load = force ? undefined : bookLoads.get(url)
  if (load) {
    // Mark as most recently used.
    bookLoads.delete(url)
    bookLoads.set(url, load)
  } else {
    const listeners = new Set<(percent: number) => void>()
    load = {
      listeners,
      content: fetchBook(url, (percent) => {
        for (const listener of listeners) listener(percent)
      }),
    }
    const current = load
    bookLoads.set(url, current)
    while (bookLoads.size > MAX_CACHED_BOOKS) {
      bookLoads.delete(bookLoads.keys().next().value!)
    }
    // A failed load is not kept, so the next open tries again.
    current.content.catch(() => {
      if (bookLoads.get(url) === current) bookLoads.delete(url)
    })
  }

  if (onProgress) load.listeners.add(onProgress)
  try {
    return await load.content
  } catch (error) {
    console.error('Failed to parse book:', error)
    return { lines: [], chapters: [] }
  } finally {
    if (onProgress) load.listeners.delete(onProgress)
  }
}
