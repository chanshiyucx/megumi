import { useMouseHover } from '@/hooks/use-tag-reveal'
import type { FileTags, Image } from '@/types/library'

type TagWriter = (id: string, imageKey: string, tags: FileTags) => Promise<void>

/**
 * Tag controls for a full-size page (preview + scroll strip). They show while
 * a mouse is over the page; a finger stars with a double tap instead, so it
 * only sees the star once set. Returns the `hoverProps` for the page and
 * `controls` to spread into a <TagOverlay>.
 */
export function useImageTags(
  comicId: string,
  image: Image,
  onTags: TagWriter | undefined,
) {
  const { hovered, hoverProps } = useMouseHover()
  const setTag = (tags: FileTags) =>
    void onTags?.(comicId, image.path, tags)

  return {
    hoverProps,
    controls: {
      open: hovered,
      title: image.filename,
      starred: image.starred,
      onStar: () => {
        setTag({ starred: !image.starred })
      },
    },
  }
}
