type TagTargetType = 'comic' | 'book' | 'video' | 'image' | 'chapter'

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
  videos: Record<string, FileTags>
  images: Record<string, FileTags>
  chapters: Record<string, FileTags>
  updatedAt?: string
}

interface PatchTagsRequest {
  targetType: TagTargetType
  targetId: string
  tags: FileTags
}

interface RemoteTabs {
  version: 1
  tabIds: string[]
  updatedAt?: string
}

type PatchTabsRequest =
  | { operation: 'open'; tabId: string }
  | { operation: 'close'; tabId: string }
  | { operation: 'move'; tabId: string; overTabId: string }
  | { operation: 'initialize'; tabIds: string[] }

const TAGS_KEY = '.megumi/tags.json'
const TABS_KEY = '.megumi/tabs.json'
const EMPTY_TAGS_ETAG = '"empty"'
const EMPTY_TABS_ETAG = '"empty-tabs"'
const MAX_TABS = 200
const MAX_TAB_ID_LENGTH = 1024
const MAX_TABS_WRITE_ATTEMPTS = 5
const REVALIDATE_HEADERS = {
  'Cache-Control': 'private, no-cache',
}

const EMPTY_TAGS: RemoteTags = {
  version: 1,
  comics: {},
  books: {},
  videos: {},
  images: {},
  chapters: {},
}

const EMPTY_TABS: RemoteTabs = {
  version: 1,
  tabIds: [],
}

const TARGET_COLLECTIONS: Record<
  TagTargetType,
  keyof Pick<RemoteTags, 'comics' | 'books' | 'videos' | 'images' | 'chapters'>
> = {
  comic: 'comics',
  book: 'books',
  video: 'videos',
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
    'Access-Control-Expose-Headers': 'ETag',
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
    videos: {},
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
    videos: normalizeCollection(source.videos),
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

function normalizeTabId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const tabId = value.trim()
  if (!tabId || tabId.length > MAX_TAB_ID_LENGTH) return null
  return tabId
}

function normalizeTabIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  const tabIds: string[] = []
  for (const valueId of value) {
    const tabId = normalizeTabId(valueId)
    if (!tabId || seen.has(tabId)) continue
    seen.add(tabId)
    tabIds.push(tabId)
    if (tabIds.length === MAX_TABS) break
  }
  return tabIds
}

function emptyTabs(): RemoteTabs {
  return { version: 1, tabIds: [] }
}

function normalizeTabs(value: unknown): RemoteTabs {
  if (!value || typeof value !== 'object') return emptyTabs()
  const source = value as Partial<RemoteTabs>
  return {
    version: 1,
    tabIds: normalizeTabIds(source.tabIds),
    updatedAt:
      typeof source.updatedAt === 'string' ? source.updatedAt : undefined,
  }
}

async function parseTabsObject(object: R2ObjectBody | null): Promise<RemoteTabs> {
  if (!object) return emptyTabs()
  try {
    return normalizeTabs(JSON.parse(await object.text()))
  } catch {
    return emptyTabs()
  }
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
    source.targetType !== 'video' &&
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

function parsePatchRequests(value: unknown): PatchTagsRequest[] | null {
  const values = Array.isArray(value) ? value : [value]
  if (!values.length) return null
  const patches = values.map(parsePatchRequest)
  return patches.every((patch): patch is PatchTagsRequest => patch !== null)
    ? patches
    : null
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

  let patches: PatchTagsRequest[] | null = null
  try {
    patches = parsePatchRequests(await request.json())
  } catch {
    patches = null
  }

  if (!patches) {
    return jsonResponse(request, env, { error: 'Invalid request' }, { status: 400 })
  }

  const tags = await readTags(env)
  for (const patch of patches) applyPatch(tags, patch)
  const etag = await writeTags(env, tags)
  return jsonResponse(request, env, tags, {
    headers: { 'Cache-Control': 'no-store', ETag: etag },
  })
}

function parseTabPatchRequest(value: unknown): PatchTabsRequest | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>

  if (source.operation === 'initialize') {
    if (!Array.isArray(source.tabIds) || source.tabIds.length > MAX_TABS) {
      return null
    }
    const tabIds = normalizeTabIds(source.tabIds)
    if (tabIds.length !== source.tabIds.length) return null
    return { operation: 'initialize', tabIds }
  }

  const tabId = normalizeTabId(source.tabId)
  if (!tabId) return null

  if (source.operation === 'open' || source.operation === 'close') {
    return { operation: source.operation, tabId }
  }

  if (source.operation === 'move') {
    const overTabId = normalizeTabId(source.overTabId)
    if (!overTabId) return null
    return { operation: 'move', tabId, overTabId }
  }

  return null
}

function parseTabPatchRequests(value: unknown): PatchTabsRequest[] | null {
  const values = Array.isArray(value) ? value : [value]
  if (!values.length) return null
  const patches = values.map(parseTabPatchRequest)
  return patches.every((patch): patch is PatchTabsRequest => patch !== null)
    ? patches
    : null
}

function applyTabPatch(
  tabs: RemoteTabs,
  patch: Exclude<PatchTabsRequest, { operation: 'initialize' }>,
) {
  if (patch.operation === 'open') {
    if (tabs.tabIds.includes(patch.tabId) || tabs.tabIds.length >= MAX_TABS) {
      return false
    }
    tabs.tabIds.push(patch.tabId)
    return true
  }

  const tabIndex = tabs.tabIds.indexOf(patch.tabId)
  if (patch.operation === 'close') {
    if (tabIndex === -1) return false
    tabs.tabIds.splice(tabIndex, 1)
    return true
  }

  const overIndex = tabs.tabIds.indexOf(patch.overTabId)
  if (tabIndex === -1 || overIndex === -1 || tabIndex === overIndex) {
    return false
  }
  const [tabId] = tabs.tabIds.splice(tabIndex, 1)
  tabs.tabIds.splice(overIndex, 0, tabId)
  return true
}

async function mutateTabs(
  env: Env,
  patches: PatchTabsRequest[],
): Promise<{ tabs: RemoteTabs; etag: string; initialized: boolean }> {
  for (let attempt = 0; attempt < MAX_TABS_WRITE_ATTEMPTS; attempt += 1) {
    const object = await env.MEGUMI_BUCKET.get(TABS_KEY)
    const tabs = await parseTabsObject(object)
    let initialized = object !== null
    let changed = false

    for (const patch of patches) {
      if (patch.operation === 'initialize') {
        if (initialized) continue
        tabs.tabIds = [...patch.tabIds]
        initialized = true
        changed = true
        continue
      }
      changed = applyTabPatch(tabs, patch) || changed
    }

    if (!changed) {
      return {
        tabs,
        etag: object?.httpEtag ?? EMPTY_TABS_ETAG,
        initialized,
      }
    }

    tabs.updatedAt = new Date().toISOString()
    const written = await env.MEGUMI_BUCKET.put(
      TABS_KEY,
      JSON.stringify(tabs),
      {
        onlyIf: object
          ? { etagMatches: object.etag }
          : { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
      },
    )
    if (written) {
      return { tabs, etag: written.httpEtag, initialized: true }
    }
  }

  throw new Error('Failed to update tabs after concurrent writes')
}

async function handleTabs(request: Request, env: Env) {
  if (request.method === 'GET') {
    const object = await env.MEGUMI_BUCKET.get(TABS_KEY)
    const etag = object?.httpEtag ?? EMPTY_TABS_ETAG
    const headers = { ...REVALIDATE_HEADERS, ETag: etag }
    if (etagMatches(request.headers.get('If-None-Match'), etag)) {
      const responseHeaders = corsHeaders(request, env)
      for (const [key, value] of new Headers(headers)) {
        responseHeaders.set(key, value)
      }
      return new Response(null, { status: 304, headers: responseHeaders })
    }
    const tabs = await parseTabsObject(object)
    return jsonResponse(
      request,
      env,
      { ...tabs, initialized: object !== null },
      { headers },
    )
  }

  if (request.method !== 'PATCH') {
    return jsonResponse(
      request,
      env,
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'GET,PATCH,OPTIONS' } },
    )
  }

  let patches: PatchTabsRequest[] | null = null
  try {
    patches = parseTabPatchRequests(await request.json())
  } catch {
    patches = null
  }

  if (!patches) {
    return jsonResponse(request, env, { error: 'Invalid request' }, { status: 400 })
  }

  try {
    const result = await mutateTabs(env, patches)
    return jsonResponse(
      request,
      env,
      { ...result.tabs, initialized: result.initialized },
      {
        headers: {
          'Cache-Control': 'no-store',
          ETag: result.etag,
        },
      },
    )
  } catch (error) {
    console.error('Failed to update tabs:', error)
    return jsonResponse(
      request,
      env,
      { error: 'Concurrent update conflict' },
      { status: 409 },
    )
  }
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

    if (url.pathname === '/tabs') {
      return handleTabs(request, env)
    }

    return jsonResponse(request, env, { error: 'Not found' }, { status: 404 })
  },
}
