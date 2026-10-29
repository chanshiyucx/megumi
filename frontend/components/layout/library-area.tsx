import { cn } from '@/lib/style'
import { useLibraryStore } from '@/store/library'
import { useUIStore } from '@/store/ui'
import { FAVORITES_LIBRARY_ID, LibraryType } from '@/types/library'
import { BookLibrary } from './book-library'
import { ComicLibrary } from './comic-library'
import { FavoritesView } from './favorites-view'
import { VideoLibrary } from './video-library'

export function LibraryArea() {
  const selectedLibraryId = useUIStore((s) => s.selectedLibraryId)
  const isSidebarCollapsed = useUIStore((s) => s.isSidebarCollapsed)
  const selectedLibrary = useLibraryStore((s) =>
    selectedLibraryId ? s.libraries[selectedLibraryId] : null,
  )

  const isFavorites = selectedLibraryId === FAVORITES_LIBRARY_ID
  if (!selectedLibrary && !isFavorites) return null

  return (
    <main
      className={cn(
        'bg-surface overflow-hidden md:block md:flex-1',
        isSidebarCollapsed ? 'block flex-1' : 'hidden',
      )}
      key={selectedLibraryId}
    >
      {!selectedLibrary ? (
        <FavoritesView />
      ) : selectedLibrary.type === LibraryType.book ? (
        <BookLibrary selectedLibrary={selectedLibrary} />
      ) : selectedLibrary.type === LibraryType.comic ? (
        <ComicLibrary selectedLibrary={selectedLibrary} />
      ) : (
        <VideoLibrary selectedLibrary={selectedLibrary} />
      )}
    </main>
  )
}
