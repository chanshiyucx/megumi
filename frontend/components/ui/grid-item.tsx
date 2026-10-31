import { type MouseEvent } from 'react'
import { TagOverlay } from '@/components/ui/tag-overlay'
import { useTagReveal } from '@/hooks/use-tag-reveal'
import { cn } from '@/lib/style'
import type { ComicProgress } from '@/types/library'

// Cover columns fill a LIST_COLUMN_CLASS column: three on iPads, four on
// desktop; phones use the full width and fit as many 128px columns as they can.
export const COVER_GRID_CLASS =
  'grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] md:grid-cols-3 min-[87.5rem]:grid-cols-4'

interface GridItemProps {
  className?: string
  title: string
  cover: string
  starred: boolean
  deleted: boolean
  isSelected?: boolean
  progress?: ComicProgress
  duration?: string
  // When set, both tag buttons and the title (centred at the bottom) show on
  // mouse hover, or after a long press with a finger; a tap still runs
  // onClick. Active tags stay shown either way. Used for page thumbnails;
  // covers / TOC only show active tags.
  revealTags?: boolean
  loading?: 'eager' | 'lazy'
  onClick: () => void
  onDoubleClick?: () => void
  onContextMenu?: (e: MouseEvent) => void
  onStar?: () => void
  onDelete?: () => void
}

export function GridItem({
  className,
  title,
  cover,
  starred,
  deleted,
  isSelected,
  progress,
  duration,
  revealTags,
  loading,
  onClick,
  onDoubleClick,
  onContextMenu,
  onStar,
  onDelete,
}: GridItemProps) {
  const { ref, open, gestures, close } = useTagReveal({
    onTap: revealTags ? onClick : undefined,
    onDoubleTap: () => onDoubleClick?.(),
    reveal: revealTags,
  })

  return (
    <figure
      ref={ref}
      className={cn(
        'group relative flex aspect-2/3 w-full shrink-0 cursor-pointer touch-manipulation flex-col overflow-hidden transition-all',
        // A long press reveals the tags rather than the system image menu.
        revealTags && 'select-none [-webkit-touch-callout:none]',
        isSelected &&
          'after:inset-ring-love after:pointer-events-none after:absolute after:inset-0 after:inset-ring-3',
        className,
      )}
      onClick={revealTags ? undefined : onClick}
      onContextMenu={onContextMenu}
      {...gestures}
    >
      <img
        src={cover}
        alt={title}
        decoding="async"
        loading={loading}
        className={cn('h-full w-full object-cover', deleted && 'grayscale')}
      />
      <TagOverlay
        layout="card"
        open={open}
        title={title}
        starred={starred}
        deleted={deleted}
        onStar={onStar}
        onDelete={onDelete}
        onClose={close}
      />

      {duration && !open && (
        <span className="absolute right-2 bottom-2 rounded-sm bg-black/75 px-1.5 py-0.5 text-xs text-white">
          {duration}
        </span>
      )}

      {progress && progress.total > 0 && (
        <div className="absolute inset-x-0 bottom-0 flex justify-between overflow-hidden bg-linear-to-t from-black/80 via-black/40 to-transparent p-2 text-xs text-white">
          <span>
            {progress.current + 1} / {progress.total}
          </span>
          {progress.percent > 0 && <span>{Math.round(progress.percent)}%</span>}
        </div>
      )}
    </figure>
  )
}
