import type { NextRequest } from 'next/server'

const memoryStore = new Map<string, string>()

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params
  const value = memoryStore.get(key)
  if (value === undefined) {
    return new Response('null', {
      headers: { 'content-type': 'application/json' },
    })
  }
  return new Response(value, {
    headers: { 'content-type': 'application/json' },
  })
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params
  memoryStore.set(key, await request.text())
  return new Response(null, { status: 204 })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params
  memoryStore.delete(key)
  return new Response(null, { status: 204 })
}
