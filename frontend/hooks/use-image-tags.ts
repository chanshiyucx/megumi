import { useMouseHover } from '@/hooks/use-tag-reveal'
import type { FileTags, Image } from '@/types/library'

type TagWriter = (id: string, imageKey: string, tags: FileTags) => Promise<void>

/**
 * Tag controls for a full-size page (preview + scroll strip). They show while
 * a mouse is over the page or while `revealed` (the reader's mark mode, which
 * a finger turns on with a tap in the middle). Returns the `hoverProps` for
 * the page and `controls` to spread into a <TagOverlay>.
 */
export function useImageTags(
  comicId: string,
  image: Image,
  onTags: TagWriter | undefined,
  revealed = false,
) {
  const { hovered, hoverProps } = useMouseHover()
  const setTag = (tags: FileTags) =>
    void onTags?.(comicId, image.path, tags)

  return {
    hoverProps,
    controls: {
      open: revealed || hovered,
      title: image.filename,
      starred: image.starred,
      deleted: image.deleted,
      onStar: () => {
        setTag({ starred: !image.starred })
      },
      onDelete: () => {
        setTag({ deleted: !image.deleted })
      },
    },
  }
}
