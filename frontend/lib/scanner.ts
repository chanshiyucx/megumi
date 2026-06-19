import type { BookContent, Chapter } from '@/types/library'

const SPECIAL_CHAPTERS = ['序章', '终章', '番外', '后记', '尾声']
const CHAPTER_SUFFIXES = new Set(['章', '回', '节', '卷', '集', '幕'])
const CHAPTER_NUMBERS = /^[0-9０-９一二三四五六七八九十百千]+/

function extractChapterTitle(line: string) {
  const trimmed = line.trim()
  if (SPECIAL_CHAPTERS.some((prefix) => trimmed.startsWith(prefix))) {
    return trimmed
  }
  if (!trimmed.startsWith('第')) return null

  const number = trimmed.slice(1).match(CHAPTER_NUMBERS)?.[0]
  if (!number) return null
  return CHAPTER_SUFFIXES.has(trimmed[1 + number.length]) ? trimmed : null
}

function parseBookText(text: string): BookContent {
  const lines: string[] = []
  const chapters: BookContent['chapters'] = []

  for (const sourceLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!sourceLine.trim()) continue
    const title = extractChapterTitle(sourceLine)
    if (title) chapters.push({ title, lineIndex: lines.length, starred: false })
    lines.push(sourceLine)
  }

  return { lines, chapters }
}

export async function parseBook(
  url: string,
  onProgress?: (percent: number) => void,
  chapters?: Chapter[],
): Promise<BookContent> {
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const total = Number(res.headers.get('content-length')) || 0
    if (!onProgress || !total || !res.body) {
      const result = parseBookText(await res.text())
      if (chapters) result.chapters = chapters
      onProgress?.(100)
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
    if (chapters) result.chapters = chapters
    onProgress(100)
    return result
  } catch (error) {
    console.error('Failed to parse book:', error)
    return { lines: [], chapters: [] }
  }
}
