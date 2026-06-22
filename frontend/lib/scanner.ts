import type { BookContent } from '@/types/library'

function parseBookText(text: string): BookContent {
  const lines: string[] = []

  for (const sourceLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!sourceLine.trim()) continue
    lines.push(sourceLine)
  }

  return { lines, chapters: [] }
}

export async function parseBook(
  url: string,
  onProgress?: (percent: number) => void,
): Promise<BookContent> {
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const total = Number(res.headers.get('content-length')) || 0
    if (!onProgress || !total || !res.body) {
      const result = parseBookText(await res.text())
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
    onProgress(100)
    return result
  } catch (error) {
    console.error('Failed to parse book:', error)
    return { lines: [], chapters: [] }
  }
}
