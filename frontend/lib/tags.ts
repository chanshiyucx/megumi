import type { FileTags } from '@/types/library'

type TagTargetType = 'comic' | 'book' | 'image' | 'chapter'

export interface RemoteTags {
  version: 1
  comics: Record<string, FileTags>
  books: Record<string, FileTags>
  images: Record<string, FileTags>
  chapters: Record<string, FileTags>
  updatedAt?: string
}

interface PatchTagsRequest {
  targetType: TagTargetType
  targetId: string
  tags: FileTags
}

interface FetchRemoteTagsOptions {
  cache?: RequestCache
}

const EMPTY_TAGS: RemoteTags = {
  version: 1,
  comics: {},
  books: {},
  images: {},
  chapters: {},
}

function tagsApiUrl() {
  return process.env.NEXT_PUBLIC_MEGUMI_TAGS_API_URL?.replace(/\/$/, '') ?? ''
}

function normalizeTags(value: unknown): RemoteTags {
  if (!value || typeof value !== 'object') return EMPTY_TAGS
  const source = value as Partial<RemoteTags>
  return {
    version: 1,
    comics: source.comics ?? {},
    books: source.books ?? {},
    images: source.images ?? {},
    chapters: source.chapters ?? {},
    updatedAt: source.updatedAt,
  }
}

export function chapterTagId(bookTitle: string, chapterTitle: string) {
  return `${bookTitle}:${chapterTitle}`
}

export async function fetchRemoteTags({
  cache,
}: FetchRemoteTagsOptions = {}): Promise<RemoteTags> {
  const baseUrl = tagsApiUrl()
  if (!baseUrl) return EMPTY_TAGS

  const response = await fetch(`${baseUrl}/tags`, cache ? { cache } : undefined)
  if (response.status === 404) return EMPTY_TAGS
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${baseUrl}/tags`)
  }

  return normalizeTags(await response.json())
}

export async function patchRemoteTags(request: PatchTagsRequest): Promise<void> {
  const baseUrl = tagsApiUrl()
  if (!baseUrl) {
    throw new Error('NEXT_PUBLIC_MEGUMI_TAGS_API_URL is not configured')
  }

  const response = await fetch(`${baseUrl}/tags`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${baseUrl}/tags`)
  }
}
