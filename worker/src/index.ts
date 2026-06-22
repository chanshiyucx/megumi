type TagTargetType = 'comic' | 'book' | 'image' | 'chapter'

interface Env {
  MEGUMI_BUCKET: R2Bucket
  ALLOWED_ORIGINS?: string
}

interface FileTags {
  starred?: boolean
  deleted?: boolean
}

interface RemoteTags {
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

const TAGS_KEY = '.megumi/tags.json'
const EMPTY_TAGS_ETAG = '"empty"'
const REVALIDATE_HEADERS = {
  'Cache-Control': 'private, no-cache',
}

const EMPTY_TAGS: RemoteTags = {
  version: 1,
  comics: {},
  books: {},
  images: {},
  chapters: {},
}

const TARGET_COLLECTIONS: Record<
  TagTargetType,
  keyof Pick<RemoteTags, 'comics' | 'books' | 'images' | 'chapters'>
> = {
  comic: 'comics',
  book: 'books',
  image: 'images',
  chapter: 'chapters',
}

function corsHeaders(request: Request, env: Env) {
  const origin = request.headers.get('Origin')
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  const headers = new Headers({
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
  })

  if (origin && allowedOrigins.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin)
  }

  return headers
}

function jsonResponse(
  request: Request,
  env: Env,
  value: unknown,
  init: ResponseInit = {},
) {
  const headers = corsHeaders(request, env)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  for (const [key, value] of new Headers(init.headers)) {
    headers.set(key, value)
  }
  return new Response(JSON.stringify(value), { ...init, headers })
}

function emptyTags(): RemoteTags {
  return {
    version: 1,
    comics: {},
    books: {},
    images: {},
    chapters: {},
  }
}

function normalizeTags(value: unknown): RemoteTags {
  if (!value || typeof value !== 'object') return emptyTags()
  const source = value as Partial<RemoteTags>
  return {
    version: 1,
    comics: normalizeCollection(source.comics),
    books: normalizeCollection(source.books),
    images: normalizeCollection(source.images),
    chapters: normalizeCollection(source.chapters),
    updatedAt:
      typeof source.updatedAt === 'string' ? source.updatedAt : undefined,
  }
}

function normalizeCollection(value: unknown): Record<string, FileTags> {
  if (!value || typeof value !== 'object') return {}

  const collection: Record<string, FileTags> = {}
  for (const [targetId, tags] of Object.entries(value)) {
    if (!targetId || !tags || typeof tags !== 'object') continue
    const normalized = normalizeFileTags(tags as FileTags)
    if (Object.keys(normalized).length) collection[targetId] = normalized
  }
  return collection
}

function normalizeFileTags(tags: FileTags): FileTags {
  const normalized: FileTags = {}
  if (tags.starred === true) normalized.starred = true
  if (tags.deleted === true) normalized.deleted = true
  return normalized
}

async function parseTagsObject(object: R2ObjectBody | null): Promise<RemoteTags> {
  if (!object) return emptyTags()
  try {
    return normalizeTags(JSON.parse(await object.text()))
  } catch {
    return emptyTags()
  }
}

async function readTags(env: Env): Promise<RemoteTags> {
  return parseTagsObject(await env.MEGUMI_BUCKET.get(TAGS_KEY))
}

async function writeTags(env: Env, tags: RemoteTags): Promise<string> {
  const object = await env.MEGUMI_BUCKET.put(TAGS_KEY, JSON.stringify(tags), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  })
  return object.httpEtag
}

function etagMatches(ifNoneMatch: string | null, etag: string) {
  if (!ifNoneMatch) return false
  const normalize = (value: string) => value.trim().replace(/^W\//, '')
  const expected = normalize(etag)
  return ifNoneMatch
    .split(',')
    .some(
      (candidate) =>
        candidate.trim() === '*' || normalize(candidate) === expected,
    )
}

function parsePatchRequest(value: unknown): PatchTagsRequest | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Partial<PatchTagsRequest>
  if (
    source.targetType !== 'comic' &&
    source.targetType !== 'book' &&
    source.targetType !== 'image' &&
    source.targetType !== 'chapter'
  ) {
    return null
  }
  if (typeof source.targetId !== 'string' || !source.targetId.trim()) {
    return null
  }
  if (!source.tags || typeof source.tags !== 'object') return null
  if (
    source.tags.starred !== undefined &&
    typeof source.tags.starred !== 'boolean'
  ) {
    return null
  }
  if (
    source.tags.deleted !== undefined &&
    typeof source.tags.deleted !== 'boolean'
  ) {
    return null
  }

  return {
    targetType: source.targetType,
    targetId: source.targetId,
    tags: source.tags,
  }
}

function applyPatch(tags: RemoteTags, patch: PatchTagsRequest) {
  const collectionName = TARGET_COLLECTIONS[patch.targetType]
  const collection = tags[collectionName]
  const current = collection[patch.targetId] ?? {}
  const next: FileTags = { ...current }

  if (patch.tags.starred !== undefined) next.starred = patch.tags.starred
  if (patch.tags.deleted !== undefined) next.deleted = patch.tags.deleted

  const normalized = normalizeFileTags(next)
  if (Object.keys(normalized).length) collection[patch.targetId] = normalized
  else delete collection[patch.targetId]

  tags.updatedAt = new Date().toISOString()
}

async function handleTags(request: Request, env: Env) {
  if (request.method === 'GET') {
    const object = await env.MEGUMI_BUCKET.get(TAGS_KEY)
    const etag = object?.httpEtag ?? EMPTY_TAGS_ETAG
    const headers = { ...REVALIDATE_HEADERS, ETag: etag }
    if (etagMatches(request.headers.get('If-None-Match'), etag)) {
      const responseHeaders = corsHeaders(request, env)
      for (const [key, value] of new Headers(headers)) {
        responseHeaders.set(key, value)
      }
      return new Response(null, {
        status: 304,
        headers: responseHeaders,
      })
    }
    const tags = await parseTagsObject(object)
    return jsonResponse(request, env, tags, { headers })
  }

  if (request.method !== 'PATCH') {
    return jsonResponse(
      request,
      env,
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'GET,PATCH,OPTIONS' } },
    )
  }

  let patch: PatchTagsRequest | null = null
  try {
    patch = parsePatchRequest(await request.json())
  } catch {
    patch = null
  }

  if (!patch) {
    return jsonResponse(request, env, { error: 'Invalid request' }, { status: 400 })
  }

  const tags = await readTags(env)
  applyPatch(tags, patch)
  const etag = await writeTags(env, tags)
  return jsonResponse(request, env, tags, {
    headers: { 'Cache-Control': 'no-store', ETag: etag },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request, env) })
    }

    if (url.pathname === '/tags') {
      return handleTags(request, env)
    }

    return jsonResponse(request, env, { error: 'Not found' }, { status: 404 })
  },
}
