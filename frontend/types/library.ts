export const LibraryType = {
  book: 'book',
  comic: 'comic',
  video: 'video',
} as const

export type LibraryType = (typeof LibraryType)[keyof typeof LibraryType]

export interface Library {
  id: string
  name: string
  path: string
  type: LibraryType
  sortOrder: number
}

/** Per-library navigation memory (device-local; lives in the UI store). */
export interface LibraryNavStatus {
  comicId?: string
  authorId?: string
  bookId?: string
  videoId?: string
}

export interface Comic {
  id: string
  title: string
  path: string
  cover: string
  libraryId: string
  starred: boolean
  deleted: boolean
}

export interface Author {
  id: string
  name: string
  path: string
  libraryId: string
  bookCount: number
}

export interface Book {
  id: string
  title: string
  path: string
  authorId: string
  libraryId: string
  starred: boolean
  deleted: boolean
  chapters: Chapter[]
}

export interface Video {
  id: string
  title: string
  path: string
  cover: string
  libraryId: string
  starred: boolean
  deleted: boolean
  durationMs: number
  width: number
  height: number
  size: number
}

export interface Chapter {
  title: string
  lineIndex: number
  starred: boolean
}

export interface BookContent {
  lines: string[]
  chapters: Chapter[]
}

export interface Image {
  path: string
  url: string
  thumbnail: string
  filename: string
  starred: boolean
  deleted: boolean
  width: number
  height: number
  index: number
}

export type ComicImageStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'failed'

export interface ComicImage {
  comicId: string
  status: ComicImageStatus
  images: Image[]
  error?: string
}

export interface FileTags {
  starred?: boolean
  deleted?: boolean
}

export interface ComicProgress {
  current: number
  total: number
  percent: number
  lastRead: number
}

export interface BookProgress {
  current: number
  total: number
  percent: number
  lastRead: number
  currentChapterTitle?: string
}
