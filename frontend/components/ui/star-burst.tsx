import { useState } from 'react'
import { TagIcon } from '@/components/ui/tag-icon'

interface Burst {
  id: number
  x: number
  y: number
  starred: boolean
}

/**
 * A star that pops where a double tap starred (or unstarred) a page, so a
 * finger sees the toggle land without a tag bar. `show` takes viewport
 * coordinates; render `node` anywhere, it is fixed-positioned.
 */
export function useStarBurst() {
  const [burst, setBurst] = useState<Burst | null>(null)

  const show = (x: number, y: number, starred: boolean) => {
    setBurst((prev) => ({ id: (prev?.id ?? 0) + 1, x, y, starred }))
  }

  const node = burst && (
    <div
      // A new key restarts the animation for a quick second toggle.
      key={burst.id}
      aria-hidden="true"
      className="animate-star-burst pointer-events-none fixed z-110"
      style={{ left: burst.x, top: burst.y }}
      onAnimationEnd={() => {
        setBurst(null)
      }}
    >
      <TagIcon kind="star" active={burst.starred} className="h-20 w-20" />
    </div>
  )

  return { show, node }
}
