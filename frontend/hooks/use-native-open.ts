import { type MouseEvent } from 'react'
import { useIsPhone } from '@/hooks/use-is-phone'

/**
 * Right-click opens the item's folder/file in the OS file manager. Phones have
 * no right-click, so no handler is attached there.
 */
export function useNativeOpen(path: string) {
  const isPhone = useIsPhone()
  if (isPhone) return undefined
  return (e: MouseEvent) => {
    e.preventDefault()
    void path
  }
}
