import { chapterTagId, patchRemoteTags, type RemoteTags } from '@/lib/tags'
import type { FileTags } from '@/types/library'

type RemoteTagTargetType = 'comic' | 'book' | 'image' | 'chapter'

interface RemoteTagTarget {
  targetType: RemoteTagTargetType
  targetId: string
}

interface TaggableItem {
  starred: boolean
  deleted?: boolean
}

interface CommitTagUpdateOptions {
  target: RemoteTagTarget
  tags: FileTags
  latestTags: RemoteTags | null
  apply: () => void
  rollback: () => void
  errorMessage: string
}

export function comicTagTarget(comic: { title: string }): RemoteTagTarget {
  return { targetType: 'comic', targetId: comic.title }
}

export function bookTagTarget(book: { title: string }): RemoteTagTarget {
  return { targetType: 'book', targetId: book.title }
}

export function imageTagTarget(imageKey: string): RemoteTagTarget {
  return { targetType: 'image', targetId: imageKey }
}

export function chapterTagTarget(
  book: { title: string },
  chapter: { title: string },
): RemoteTagTarget {
  return {
    targetType: 'chapter',
    targetId: chapterTagId(book.title, chapter.title),
  }
}

export function readRemoteTags(
  remoteTags: RemoteTags,
  target: RemoteTagTarget,
) {
  return tagBucket(remoteTags, target)[target.targetId] ?? {}
}

export function applyFileTags(item: TaggableItem, tags: FileTags) {
  if (tags.starred !== undefined) item.starred = tags.starred
  if (tags.deleted !== undefined && 'deleted' in item) {
    item.deleted = tags.deleted
  }
}

export function snapshotFileTags(item: TaggableItem): FileTags {
  return {
    starred: item.starred,
    ...(item.deleted === undefined ? {} : { deleted: item.deleted }),
  }
}

export async function commitTagUpdate({
  target,
  tags,
  latestTags,
  apply,
  rollback,
  errorMessage,
}: CommitTagUpdateOptions) {
  apply()

  try {
    await patchRemoteTags({ ...target, tags })
    if (latestTags) {
      tagBucket(latestTags, target)[target.targetId] = {
        ...tagBucket(latestTags, target)[target.targetId],
        ...tags,
      }
    }
  } catch (error) {
    console.error(errorMessage, error)
    rollback()
  }
}

function tagBucket(remoteTags: RemoteTags, target: RemoteTagTarget) {
  switch (target.targetType) {
    case 'comic':
      return remoteTags.comics
    case 'book':
      return remoteTags.books
    case 'image':
      return remoteTags.images
    case 'chapter':
      return remoteTags.chapters
  }
}
