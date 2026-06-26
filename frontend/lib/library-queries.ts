import type { Book, Comic } from '@/types/library'

interface TaggedItem {
  starred: boolean
  deleted: boolean
}

interface ComicCollectionState {
  comics: Record<string, Comic>
  libraryComics: Record<string, string[]>
}

interface BookCollectionState {
  books: Record<string, Book>
  authorBooks: Record<string, string[]>
}

function exists<T>(value: T | undefined): value is T {
  return value !== undefined
}

function compareTagPriority(a: TaggedItem, b: TaggedItem) {
  if (a.deleted !== b.deleted) return a.deleted ? 1 : -1
  if (a.starred !== b.starred) return a.starred ? -1 : 1
  return 0
}

export function selectOrderedComicsForLibrary(
  state: ComicCollectionState,
  libraryId: string,
) {
  return (state.libraryComics[libraryId] ?? [])
    .map((id) => state.comics[id])
    .filter(exists)
    .toSorted(compareTagPriority)
}

export function selectOrderedBooksForAuthor(
  state: BookCollectionState,
  authorId: string,
) {
  return (state.authorBooks[authorId] ?? [])
    .map((id) => state.books[id])
    .filter(exists)
    .toSorted(compareTagPriority)
}
