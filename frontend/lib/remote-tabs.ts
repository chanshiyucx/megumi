export interface RemoteTabs {
  version: 1
  tabIds: string[]
  initialized: boolean
  updatedAt?: string
}

export type RemoteTabMutation =
  | { operation: 'open'; tabId: string }
  | { operation: 'close'; tabId: string }
  | { operation: 'move'; tabId: string; overTabId: string }
  | { operation: 'initialize'; tabIds: string[] }

const EMPTY_REMOTE_TABS: RemoteTabs = {
  version: 1,
  tabIds: [],
  initialized: false,
}

let tabWriteQueue = Promise.resolve()

function tabsApiUrl() {
  return process.env.NEXT_PUBLIC_MEGUMI_TAGS_API_URL?.replace(/\/$/, '') ?? ''
}

function normalizeRemoteTabs(value: unknown): RemoteTabs {
  if (!value || typeof value !== 'object') return EMPTY_REMOTE_TABS
  const source = value as Partial<RemoteTabs>
  const seen = new Set<string>()
  const tabIds: string[] = []

  if (Array.isArray(source.tabIds)) {
    for (const valueId of source.tabIds) {
      if (typeof valueId !== 'string') continue
      const tabId = valueId.trim()
      if (!tabId || seen.has(tabId)) continue
      seen.add(tabId)
      tabIds.push(tabId)
    }
  }

  return {
    version: 1,
    tabIds,
    initialized: source.initialized === true,
    updatedAt:
      typeof source.updatedAt === 'string' ? source.updatedAt : undefined,
  }
}

async function patchRemoteTabs(
  mutation: RemoteTabMutation | RemoteTabMutation[],
) {
  const baseUrl = tabsApiUrl()
  if (!baseUrl) {
    throw new Error('NEXT_PUBLIC_MEGUMI_TAGS_API_URL is not configured')
  }

  const response = await fetch(`${baseUrl}/tabs`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mutation),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${baseUrl}/tabs`)
  }
  return normalizeRemoteTabs(await response.json())
}

export function queueRemoteTabMutation(
  mutation: RemoteTabMutation | RemoteTabMutation[],
) {
  const pending = tabWriteQueue.then(() => patchRemoteTabs(mutation))
  tabWriteQueue = pending.then(
    () => undefined,
    () => undefined,
  )
  return pending
}

export async function fetchRemoteTabs(): Promise<RemoteTabs> {
  await tabWriteQueue

  const baseUrl = tabsApiUrl()
  if (!baseUrl) {
    throw new Error('NEXT_PUBLIC_MEGUMI_TAGS_API_URL is not configured')
  }

  const response = await fetch(`${baseUrl}/tabs`, { cache: 'no-cache' })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${baseUrl}/tabs`)
  }
  return normalizeRemoteTabs(await response.json())
}
